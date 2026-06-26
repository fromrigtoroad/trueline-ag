import struct
import os
import math

def write_mock_ibt(file_path):
    # Variables definition
    # name, type (2=int, 4=float, 5=double), count, offset
    vars_def = [
        ('Lap', 2, 1, 0),
        ('LapDistPct', 4, 1, 4),
        ('Throttle', 4, 1, 8),
        ('Brake', 4, 1, 12),
        ('Speed', 4, 1, 16),
        ('SessionTime', 5, 1, 20),
        ('Gear', 2, 1, 28)
    ]
    
    buf_len = 32 # total frame size (4 + 4 + 4 + 4 + 4 + 8 + 4)
    num_vars = len(vars_def)
    
    # Offsets layout:
    # 0 - 112: Header
    # 112 - 144: Disk subheader (32 bytes)
    # 144: Session info (YAML) (say 64 bytes)
    # 208: Variable headers (6 * 144 = 864 bytes)
    # 1072: Data buffer starts (aligned to 16 bytes: 1072 is 16-aligned)
    
    session_info_offset = 144
    session_info_yaml = b"TrackName: mock_track\nCarName: mock_car\n"
    session_info_len = len(session_info_yaml)
    
    # Align variable headers offset to 16 bytes
    var_header_offset = (session_info_offset + session_info_len + 15) // 16 * 16
    
    # Align data buffer offset to 16 bytes
    data_buffer_offset = (var_header_offset + num_vars * 144 + 15) // 16 * 16
    
    # Create Header bytes
    # ver, status, tickRate, sessionInfoUpdate, sessionInfoLen, sessionInfoOffset, numVars, varHeaderOffset, numBuf, bufLen, pad1[2]
    header_data = [
        1, # ver
        1, # status
        60, # tickRate
        1, # sessionInfoUpdate
        session_info_len,
        session_info_offset,
        num_vars,
        var_header_offset,
        1, # numBuf
        buf_len,
        0, 0 # pad1
    ]
    header_bytes = bytearray(struct.pack('12i', *header_data))
    
    # Add varBuf array (4 * 16 = 64 bytes)
    # varBuf[0]: tickCount=1000, bufOffset=data_buffer_offset, pad[2]=0,0
    header_bytes.extend(struct.pack('4i', 1000, data_buffer_offset, 0, 0))
    for _ in range(3):
        header_bytes.extend(struct.pack('4i', 0, 0, 0, 0))
        
    # Create Disk Subheader bytes (32 bytes)
    # sessionStartDate (int64), sessionStartTime (double), sessionEndTime (double), sessionLapCount (int), sessionRecordCount (int)
    num_records = 1200 # 20 seconds at 60Hz (2 laps)
    disk_subheader = struct.pack('qddii', 1234567890, 0.0, 20.0, 2, num_records)
    
    # Combine headers
    file_bytes = bytearray()
    file_bytes.extend(header_bytes)
    file_bytes.extend(disk_subheader)
    
    # Pad to session_info_offset
    file_bytes.extend(b'\x00' * (session_info_offset - len(file_bytes)))
    file_bytes.extend(session_info_yaml)
    
    # Pad to var_header_offset
    file_bytes.extend(b'\x00' * (var_header_offset - len(file_bytes)))
    
    # Write variable headers (144 bytes each)
    # int type; int offset; int count; int pad; char name[32]; char desc[64]; char unit[32];
    for name, v_type, count, offset in vars_def:
        name_b = name.encode('ascii').ljust(32, b'\x00')
        desc_b = f"Mock {name}".encode('ascii').ljust(64, b'\x00')
        unit_b = "units".encode('ascii').ljust(32, b'\x00')
        var_bytes = struct.pack('iiii32s64s32s', v_type, offset, count, 0, name_b, desc_b, unit_b)
        file_bytes.extend(var_bytes)
        
    # Pad to data_buffer_offset
    file_bytes.extend(b'\x00' * (data_buffer_offset - len(file_bytes)))
    
    # Write telemetry frames (1200 records * 28 bytes)
    # We will simulate 2 laps:
    # Lap 1: records 0 to 600
    # Lap 2: records 600 to 1200
    dt = 1/60.0
    for r in range(num_records):
        # Calculate current lap and position
        if r < 600:
            lap = 1
            pct = r / 600.0
            time_sec = r * dt
        else:
            lap = 2
            pct = (r - 600) / 600.0
            time_sec = r * dt
            
        # Simulate simple inputs
        # Throttle: full on straight, drops in corner, back on straight
        # Speed: increases, decreases in corner, increases
        # Brake: spikes in corner entry
        # Corner entry around pct 0.4 to 0.6
        if 0.4 <= pct <= 0.5:
            # Braking zone
            brake = 0.8 * ((0.5 - pct) / 0.1) # trail off
            throttle = 0.0
            speed = 30.0 - 15.0 * (pct - 0.4) / 0.1
        elif 0.5 < pct <= 0.6:
            # Corner exit
            brake = 0.0
            throttle = 1.0 * (pct - 0.5) / 0.1
            speed = 15.0 + 15.0 * (pct - 0.5) / 0.1
        else:
            # Straight
            brake = 0.0
            throttle = 1.0
            speed = 30.0 + 15.0 * math.sin(pct * math.pi)
            
        # Gear simulation
        if speed < 18.0:
            gear = 1
        elif speed < 25.0:
            gear = 2
        else:
            gear = 3
            
        # Pack frame bytes:
        # Lap (int), LapDistPct (float), Throttle (float), Brake (float), Speed (float), SessionTime (double), Gear (int)
        frame = struct.pack('<iffffdi', lap, pct, throttle, brake, speed, time_sec, gear)
        file_bytes.extend(frame)
        
    # Write file to disk
    dir_name = os.path.dirname(file_path)
    if dir_name:
        os.makedirs(dir_name, exist_ok=True)
    with open(file_path, 'wb') as f:
        f.write(file_bytes)
        
    print(f"Generated mock IBT file at: {file_path}")

if __name__ == "__main__":
    write_mock_ibt("mock_telemetry.ibt")
