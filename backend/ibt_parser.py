import struct
import os
import json
import numpy as np

# iRacing SDK Constants
IRSDK_MAX_BUFS = 4
IRSDK_MAX_STRING = 32
IRSDK_MAX_DESC = 64

# Variable type sizes and unpack format characters
# Type mapping: 
# 0: char, 1: bool, 2: int, 3: bitfield, 4: float, 5: double
VAR_TYPE_INFO = {
    0: (1, 'c'),
    1: (1, '?'),
    2: (4, 'i'),
    3: (4, 'I'),
    4: (4, 'f'),
    5: (8, 'd')
}

def parse_ibt_file(file_path):
    """
    Parses a raw iRacing .ibt file and extracts completed laps telemetry.
    Returns a dictionary with lap metadata and telemetry data.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    with open(file_path, 'rb') as f:
        file_data = f.read()

    # 1. Parse main header (112 bytes)
    # C++ Struct:
    # int ver; int status; int tickRate;
    # int sessionInfoUpdate; int sessionInfoLen; int sessionInfoOffset;
    # int numVars; int varHeaderOffset;
    # int numBuf; int bufLen; int pad1[2];
    # irsdk_varBuf varBuf[4]; (each varBuf is: int tickCount; int bufOffset; int pad[2]; -> 16 bytes)
    header_format = '12i'
    header_size = 48
    header_unpacked = struct.unpack(header_format, file_data[:header_size])
    
    ver = header_unpacked[0]
    status = header_unpacked[1]
    tick_rate = header_unpacked[2]
    session_info_update = header_unpacked[3]
    session_info_len = header_unpacked[4]
    session_info_offset = header_unpacked[5]
    num_vars = header_unpacked[6]
    var_header_offset = header_unpacked[7]
    num_buf = header_unpacked[8]
    buf_len = header_unpacked[9]

    # Parse varBuf array (4 * 16 = 64 bytes)
    var_buf_offset = 48
    var_bufs = []
    for i in range(IRSDK_MAX_BUFS):
        offset = var_buf_offset + i * 16
        tick_count, buf_offset, pad0, pad1 = struct.unpack('4i', file_data[offset:offset+16])
        var_bufs.append({
            'tickCount': tick_count,
            'bufOffset': buf_offset
        })

    # 2. Parse disk subheader (32 bytes) at offset 112
    # C++ Struct:
    # time_t sessionStartDate; double sessionStartTime; double sessionEndTime;
    # int sessionLapCount; int sessionRecordCount;
    # Note: time_t is 8 bytes, double is 8 bytes, int is 4 bytes. Format: 'qddii'
    disk_subheader_offset = 112
    disk_subheader_data = file_data[disk_subheader_offset:disk_subheader_offset+32]
    session_start_date, session_start_time, session_end_time, session_lap_count, session_record_count = struct.unpack('qddii', disk_subheader_data)

    # 3. Parse variable headers array starting at var_header_offset
    # Each varHeader is 144 bytes:
    # int type; int offset; int count; int pad;
    # char name[32]; char desc[64]; char unit[32];
    # Format: 'iiii32s64s32s'
    vars_dict = {}
    for i in range(num_vars):
        offset = var_header_offset + i * 144
        var_data = file_data[offset:offset+144]
        v_type, v_offset, v_count, v_pad, v_name, v_desc, v_unit = struct.unpack('iiii32s64s32s', var_data)
        
        # Clean up string fields (strip null bytes and decode)
        name_str = v_name.split(b'\x00')[0].decode('ascii', errors='ignore')
        desc_str = v_desc.split(b'\x00')[0].decode('ascii', errors='ignore')
        unit_str = v_unit.split(b'\x00')[0].decode('ascii', errors='ignore')
        
        vars_dict[name_str] = {
            'type': v_type,
            'offset': v_offset,
            'count': v_count,
            'name': name_str,
            'desc': desc_str,
            'unit': unit_str
        }

    # Find the telemetry buffer offset
    # In disk files, telemetry records are written sequentially at var_bufs[0]['bufOffset']
    data_buffer_offset = var_bufs[0]['bufOffset']
    
    # Check that required telemetry channels exist
    required_channels = ['Lap', 'LapDistPct', 'Throttle', 'Brake', 'Speed', 'SessionTime']
    for ch in required_channels:
        if ch not in vars_dict:
            # Try lowercase variations or common alternatives
            alternatives = {
                'Speed': ['Velocity', 'speed', 'velocity'],
                'SessionTime': ['SessionTime', 'time', 'Time']
            }
            found = False
            if ch in alternatives:
                for alt in alternatives[ch]:
                    if alt in vars_dict:
                        vars_dict[ch] = vars_dict[alt]
                        found = True
                        break
            if not found:
                raise ValueError(f"Required telemetry channel '{ch}' is missing from the file!")

    has_gear = 'Gear' in vars_dict or 'gear' in vars_dict
    if not has_gear:
        # Check lowercase variation
        if 'gear' in vars_dict:
            vars_dict['Gear'] = vars_dict['gear']
            has_gear = True

    # Helper function to extract a variable value from a single record frame bytes
    def extract_val(record_bytes, var_meta):
        v_offset = var_meta['offset']
        v_type = var_meta['type']
        v_count = var_meta['count']
        
        type_size, fmt_char = VAR_TYPE_INFO[v_type]
        total_size = type_size * v_count
        
        chunk = record_bytes[v_offset:v_offset+total_size]
        if v_count == 1:
            return struct.unpack(fmt_char, chunk)[0]
        else:
            return list(struct.unpack(f"{v_count}{fmt_char}", chunk))

    # 4. Read all records and group them by lap
    laps_raw = {}
    
    for r in range(session_record_count):
        offset = data_buffer_offset + r * buf_len
        record_bytes = file_data[offset:offset+buf_len]
        
        lap = int(extract_val(record_bytes, vars_dict['Lap']))
        lap_dist_pct = float(extract_val(record_bytes, vars_dict['LapDistPct']))
        throttle = float(extract_val(record_bytes, vars_dict['Throttle']))
        brake = float(extract_val(record_bytes, vars_dict['Brake']))
        speed = float(extract_val(record_bytes, vars_dict['Speed'])) # usually in m/s
        session_time = float(extract_val(record_bytes, vars_dict['SessionTime']))
        gear = int(extract_val(record_bytes, vars_dict['Gear'])) if has_gear else 0
        
        if lap not in laps_raw:
            laps_raw[lap] = []
            
        laps_raw[lap].append({
            'time': session_time,
            'distPct': lap_dist_pct,
            'throttle': throttle,
            'brake': brake,
            'speed': speed,
            'gear': gear
        })

    # 5. Process laps to find completed, valid ones
    completed_laps = []
    
    for lap_num, samples in laps_raw.items():
        if len(samples) < 100:  # Need a reasonable number of samples
            continue
            
        # Sort samples by session time to be safe
        samples.sort(key=lambda s: s['time'])
        
        # Split samples into continuous segments to filter out resets to pits
        segments = []
        current_segment = [samples[0]]
        for idx in range(1, len(samples)):
            prev = samples[idx-1]
            curr = samples[idx]
            
            # Reset/Teleport checks:
            # Time gap > 1.5s OR large distance gap
            time_gap = curr['time'] - prev['time'] > 1.5
            dist_jump = abs(curr['distPct'] - prev['distPct']) > 0.15
            
            if time_gap or dist_jump:
                segments.append(current_segment)
                current_segment = []
            current_segment.append(curr)
        segments.append(current_segment)
        
        # Check if any segment is a complete lap
        for seg in segments:
            if len(seg) < 100:
                continue
                
            start_pct = seg[0]['distPct']
            end_pct = seg[-1]['distPct']
            
            # Completed lap check
            if start_pct < 0.05 and end_pct > 0.95:
                lap_time = seg[-1]['time'] - seg[0]['time']
                
                # Format lap time as MM:SS.fff
                minutes = int(lap_time // 60)
                seconds = int(lap_time % 60)
                ms = int((lap_time % 1) * 1000)
                lap_time_str = f"{minutes:02d}:{seconds:02d}.{ms:03d}"
                
                completed_laps.append({
                    'lap_num': lap_num,
                    'lap_time': lap_time,
                    'lap_time_str': lap_time_str,
                    'samples': seg
                })
            
    # Sort completed laps by time (fastest first) or by lap number
    # Let's keep it sorted by lap number so it's chronologically ordered
    completed_laps.sort(key=lambda x: x['lap_num'])
    
    return completed_laps

def interpolate_lap_data(samples, num_points=2000):
    """
    Interpolates lap samples into a fixed track position grid (0.0 to 1.0)
    so they can be aligned with any other lap's inputs.
    """
    # Extract arrays
    dist_pct = np.array([s['distPct'] for s in samples])
    throttle = np.array([s['throttle'] for s in samples])
    brake = np.array([s['brake'] for s in samples])
    speed = np.array([s['speed'] for s in samples])
    time_arr = np.array([s['time'] for s in samples])
    gear = np.array([s.get('gear', 0) for s in samples])
    
    # Normalize time so the lap starts at t=0
    time_arr = time_arr - time_arr[0]
    
    # Force LapDistPct to be strictly increasing for interpolation (remove duplicates/jitter)
    # iRacing telemetry sometimes has minor noise where LapDistPct jumps slightly backwards
    clean_indices = [0]
    for idx in range(1, len(dist_pct)):
        if dist_pct[idx] > dist_pct[clean_indices[-1]]:
            clean_indices.append(idx)
            
    # If too few points are left, just use the original (unlikely to happen)
    if len(clean_indices) > 50:
        dist_pct = dist_pct[clean_indices]
        throttle = throttle[clean_indices]
        brake = brake[clean_indices]
        speed = speed[clean_indices]
        time_arr = time_arr[clean_indices]
        gear = gear[clean_indices]

    # Create target grid (0.0 to 1.0)
    target_grid = np.linspace(0.0, 1.0, num_points)
    
    # Perform linear interpolation
    interp_throttle = np.interp(target_grid, dist_pct, throttle)
    interp_brake = np.interp(target_grid, dist_pct, brake)
    interp_speed = np.interp(target_grid, dist_pct, speed)
    interp_time = np.interp(target_grid, dist_pct, time_arr)
    interp_gear = np.interp(target_grid, dist_pct, gear)
    
    # Construct list of interpolated points
    interpolated_points = []
    for i in range(num_points):
        interpolated_points.append({
            'pct': float(target_grid[i]),
            'throttle': float(interp_throttle[i]),
            'brake': float(interp_brake[i]),
            'speed': float(interp_speed[i]),
            'time': float(interp_time[i]),
            'gear': int(round(float(interp_gear[i])))
        })
        
    return interpolated_points

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python ibt_parser.py <path_to_ibt_file>")
        sys.exit(1)
        
    file_path = sys.argv[1]
    print(f"Parsing: {file_path}...")
    try:
        laps = parse_ibt_file(file_path)
        print(f"Found {len(laps)} completed laps:")
        for lap in laps:
            print(f"Lap {lap['lap_num']}: {lap['lap_time_str']} ({len(lap['samples'])} samples)")
            
        if laps:
            # Interpolate the fastest lap
            fastest_lap = min(laps, key=lambda x: x['lap_time'])
            print(f"\nInterpolating fastest Lap {fastest_lap['lap_num']} ({fastest_lap['lap_time_str']})...")
            points = interpolate_lap_data(fastest_lap['samples'])
            print(f"Interpolated into {len(points)} points.")
            print(f"First point: {points[0]}")
            print(f"Middle point: {points[len(points)//2]}")
            print(f"Last point: {points[-1]}")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
