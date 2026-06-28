import asyncio
import json
import os
import sys
import math
import traceback
import websockets
import logging
from mock_sim import MockTelemetryGenerator
from ibt_parser import parse_ibt_file, interpolate_lap_data

# Configure file logging in the user home directory
try:
    log_dir = os.path.expanduser("~")
    log_path = os.path.join(log_dir, "bridge.log")
    logging.basicConfig(
        filename=log_path,
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        filemode="w"
    )
    logging.info(f"Bridge Logging Initialized at: {log_path}")
except Exception as log_err:
    print(f"Failed to configure logging: {log_err}")

# Attempt to import pyirsdk. It might fail on non-Windows environments.
try:
    import irsdk
    IRSDK_AVAILABLE = True
except ImportError:
    IRSDK_AVAILABLE = False

class TelemetryBridge:
    def __init__(self, host="127.0.0.1", port=8765):
        self.host = host
        self.port = port
        self.clients = set()
        
        # Simulators / SDK state
        self.ir = None
        self.mock_sim = MockTelemetryGenerator()
        self.use_mock = not (IRSDK_AVAILABLE and sys.platform == "win32")
        self.ir_connected = False
        
        # Telemetry comparison state
        self.reference_lap = None # List of dicts: [{'pct', 'throttle', 'brake', 'speed', 'time'}]
        self.reference_lap_num = None
        self.reference_lap_time_str = None
        self.braking_points = []
        self.throttle_points = []
        self.shift_points = []
        
        # Recording state
        self.is_recording = False
        self.recorded_ticks = []
        
        # Alignment state for GPS -> Live world-space coordinates
        self.align_live_pts = [] # list of (x, z)
        self.align_ref_pts = []  # list of (x, z)
        self.align_theta = 0.0
        self.align_dx = 0.0
        self.align_dz = 0.0
        self.aligned = False
        
        # Timing state
        self.last_lap = -1
        self.lap_start_time = 0.0
        
        # Cache for parsed IBT files
        self.parsed_ibt_cache = {}

    def set_reference_lap(self, interpolated, lap_num, lap_time_str):
        self.reference_lap = interpolated
        self.reference_lap_num = lap_num
        self.reference_lap_time_str = lap_time_str
        self.braking_points = []
        self.throttle_points = []
        self.shift_points = []
        
        # Reset alignment state
        self.align_live_pts = []
        self.align_ref_pts = []
        self.align_theta = 0.0
        self.align_dx = 0.0
        self.align_dz = 0.0
        self.aligned = False
        
        if not interpolated:
            return
            
        # Calculate metric x_metric, z_metric for all samples using the first valid point as origin
        R_earth = 6371000.0
        first_valid = next((s for s in interpolated if s.get("lat") is not None and s.get("lon") is not None), None)
        if first_valid:
            lat_origin = first_valid["lat"]
            lon_origin = first_valid["lon"]
            lat_origin_rad = lat_origin * math.pi / 180.0
            lon_origin_rad = lon_origin * math.pi / 180.0
            cos_lat = math.cos(lat_origin_rad)
            
            for s in interpolated:
                lat_rad = s.get("lat", 0.0) * math.pi / 180.0
                lon_rad = s.get("lon", 0.0) * math.pi / 180.0
                s["x_metric"] = (lon_rad - lon_origin_rad) * R_earth * cos_lat
                s["z_metric"] = (lat_rad - lat_origin_rad) * R_earth
        
        num_points = len(interpolated)
        for i in range(num_points):
            curr = interpolated[i]
            prev = interpolated[(i - 1) % num_points]
            
            # Brake starts: rises above 5%
            if curr.get('brake', 0.0) > 0.05 and prev.get('brake', 0.0) <= 0.05:
                self.braking_points.append(curr['pct'])
                
            # Throttle starts: rises above 5%
            if curr.get('throttle', 0.0) > 0.05 and prev.get('throttle', 0.0) <= 0.05:
                self.throttle_points.append(curr['pct'])
                
            # Gear changes (skip index 0 to avoid wrap-around fake shifts at start/finish line)
            if i > 0:
                curr_gear = curr.get('gear', 0)
                prev_gear = prev.get('gear', 0)
                if curr_gear != prev_gear and curr_gear in [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8] and prev_gear in [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]:
                    shift_type = 'up' if curr_gear > prev_gear else 'down'
                    self.shift_points.append((curr['pct'], shift_type))

    def get_safe_val(self, key, default=0.0):
        """
        Safely reads a telemetry variable from the IRSDK wrapper, returning a default value if missing.
        """
        if self.use_mock or not self.ir:
            return default
        try:
            val = self.ir[key]
            return val if val is not None else default
        except Exception:
            return default

    def init_irsdk(self):
        """
        Initializes connection to the live iRacing SDK.
        """
        if self.use_mock:
            print("Running in MOCK mode (macOS or no Win32).")
            return
            
        try:
            if not self.ir:
                self.ir = irsdk.IRSDK()
            
            # Check if game is running and connected
            if self.ir.startup():
                self.ir_connected = True
                try:
                    var_names = [var.name for var in self.ir.telemetry_vars]
                    logging.info(f"Available telemetry variables ({len(var_names)}): " + ", ".join(var_names))
                except Exception as log_err:
                    logging.error(f"Failed to log telemetry variables: {log_err}")
            else:
                self.ir_connected = False
        except Exception as e:
            print(f"Failed to startup iRacing SDK: {e}")
            self.ir_connected = False

    async def register_client(self, websocket):
        self.clients.add(websocket)
        print(f"Client connected. Total clients: {len(self.clients)}")
        # Send initial reference state if loaded
        if self.reference_lap:
            await websocket.send(json.dumps({
                "type": "reference_loaded",
                "lapNum": self.reference_lap_num,
                "lapTimeStr": self.reference_lap_time_str
            }))

    async def unregister_client(self, websocket):
        self.clients.remove(websocket)
        print(f"Client disconnected. Total clients: {len(self.clients)}")

    async def broadcast(self, message):
        if not self.clients:
            return
        # Create a list of send tasks to run them concurrently
        await asyncio.gather(*[client.send(message) for client in self.clients], return_exceptions=True)

    def get_telemetry_tick(self):
        """
        Gets a single telemetry tick from either iRacing or the mock simulator.
        Calculates time delta if a reference lap is loaded.
        """
        raw_data = {}
        
        if self.use_mock:
            raw_data = self.mock_sim.update(1/60.0)
            self.ir_connected = True
        else:
            # Check live iRacing SDK
            if not self.ir or not self.ir.is_connected:
                self.init_irsdk()
                
            if self.ir_connected and self.ir.is_initialized:
                try:
                    # Get variables from shared memory
                    raw_data = {
                        "lap": self.ir["Lap"],
                        "lapDistPct": self.ir["LapDistPct"],
                        "lapDist": self.ir["LapDist"],
                        "throttle": self.ir["Throttle"],
                        "brake": self.ir["Brake"],
                        "speed": self.ir["Speed"] * 3.6,  # Convert m/s to km/h
                        "gear": self.ir["Gear"],
                        "sessionTime": self.ir["SessionTime"],
                        "Lat": self.get_safe_val("Lat", 0.0),
                        "Lon": self.get_safe_val("Lon", 0.0),
                        "Alt": self.get_safe_val("Alt", 0.0)
                    }
                except Exception as e:
                    print(f"Error reading telemetry: {e}")
                    self.ir_connected = False
            else:
                self.ir_connected = False
                
        if not self.ir_connected:
            return {
                "type": "telemetry",
                "connected": False,
                "is_mock": self.use_mock,
                "data": None
            }

        lap = raw_data["lap"]
        lap_dist_pct = raw_data["lapDistPct"]
        session_time = raw_data["sessionTime"]

        # 1. Handle lap transitions and timing
        if lap != self.last_lap:
            self.lap_start_time = session_time
            self.last_lap = lap
            # If recording, check if we need to process the lap we just completed
            if self.is_recording and len(self.recorded_ticks) > 500:
                # To prevent storing partial data, we could save the finished lap
                # For simplicity, we just keep accumulating ticks and slice them in stop_recording
                pass
                
        user_lap_time = session_time - self.lap_start_time

        # Safely get GPS coordinates for player
        user_lat = 0.0
        user_lon = 0.0
        user_alt = 0.0
        if self.use_mock:
            user_lat = raw_data.get("Lat", 0.0)
            user_lon = raw_data.get("Lon", 0.0)
            user_alt = raw_data.get("Alt", 0.0)
        else:
            user_lat = self.get_safe_val("Lat", 0.0)
            user_lon = self.get_safe_val("Lon", 0.0)
            user_alt = self.get_safe_val("Alt", 0.0)

        # Extract live metric coordinates (CarIdxPosX / CarIdxPosZ)
        user_x = 0.0
        user_z = 0.0
        player_idx = int(self.get_safe_val("PlayerCarIdx", 0))
        
        if self.use_mock:
            if self.reference_lap:
                R_earth = 6371000.0
                first_valid = next((s for s in self.reference_lap if s.get("lat") is not None and s.get("lon") is not None), None)
                if first_valid:
                    lat_origin_rad = first_valid["lat"] * math.pi / 180.0
                    lon_origin_rad = first_valid["lon"] * math.pi / 180.0
                    cos_lat = math.cos(lat_origin_rad)
                    
                    user_lat_rad = user_lat * math.pi / 180.0
                    user_lon_rad = user_lon * math.pi / 180.0
                    user_x = (user_lon_rad - lon_origin_rad) * R_earth * cos_lat
                    user_z = (user_lat_rad - lat_origin_rad) * R_earth
                    
                    # For mock, alignment is 1:1 Identity
                    self.align_theta = 0.0
                    self.align_dx = 0.0
                    self.align_dz = 0.0
                    self.aligned = True
        else:
            try:
                pos_x_arr = self.ir["CarIdxPosX"]
                pos_z_arr = self.ir["CarIdxPosZ"]
                if pos_x_arr and len(pos_x_arr) > player_idx:
                    user_x = pos_x_arr[player_idx]
                if pos_z_arr and len(pos_z_arr) > player_idx:
                    user_z = pos_z_arr[player_idx]
            except Exception as e:
                # Log coordinate extraction errors
                if not hasattr(self, "_last_coord_err_log") or self.tick_counter % 300 == 0:
                    logging.error(f"Error reading CarIdxPosX/PosZ: {e}")
                    self._last_coord_err_log = True

        # Debug logging loop diagnostics
        if not hasattr(self, "tick_counter"):
            self.tick_counter = 0
        self.tick_counter += 1
        
        if self.tick_counter % 300 == 0:
            try:
                logging.info(f"Tick {self.tick_counter}: ir_connected={self.ir_connected}, use_mock={self.use_mock}")
                if self.ir:
                    pos_x = self.get_safe_val("CarIdxPosX", None)
                    pos_z = self.get_safe_val("CarIdxPosZ", None)
                    logging.info(f"SDK Variables: PlayerCarIdx={player_idx}, Lat={user_lat}, Lon={user_lon}")
                    logging.info(f"Live coordinates: user_x={user_x:.2f}, user_z={user_z:.2f}")
                    if pos_x is not None:
                        logging.info(f"CarIdxPosX size={len(pos_x) if hasattr(pos_x, '__len__') else 'not_len'}, type={type(pos_x)}")
                    else:
                        logging.info("CarIdxPosX is None!")
                if self.reference_lap:
                    logging.info(f"Reference Lap loaded: {len(self.reference_lap)} points. Aligned: {self.aligned}, theta={self.align_theta:.4f}, dx={self.align_dx:.1f}, dz={self.align_dz:.1f}, buffer={len(self.align_live_pts)}")
            except Exception as log_ex:
                print(f"Error writing to bridge.log: {log_ex}")

        # 2. Record tick if enabled
        if self.is_recording:
            self.recorded_ticks.append({
                "time": session_time,
                "distPct": lap_dist_pct,
                "throttle": raw_data["throttle"],
                "brake": raw_data["brake"],
                "speed": raw_data["speed"] / 3.6,  # store in m/s
                "gear": raw_data["gear"],
                "lat": user_lat,
                "lon": user_lon,
                "alt": user_alt
            })

        # 3. Calculate comparison telemetry if reference is loaded
        comparison = {
            "hasReference": False,
            "distToBrake": 9999.0,
            "distToThrottle": 9999.0,
            "distToShift": 9999.0,
            "shiftType": "",
            "lateralDeviation": 0.0,
            "refBrakeActive": False,
            "refThrottleActive": False
        }
        
        if self.reference_lap and 0.0 <= lap_dist_pct <= 1.0:
            num_points = len(self.reference_lap)
            # Find closest reference index
            ref_idx = min(num_points - 1, max(0, int(lap_dist_pct * (num_points - 1))))
            ref_point = self.reference_lap[ref_idx]
            
            # Time delta calculation: user_lap_time - ref_lap_time at this distance
            delta_time = user_lap_time - ref_point["time"]
            
            # Estimate track length in meters
            lap_dist = raw_data.get("lapDist", 0.0)
            track_length = 4000.0
            if lap_dist_pct > 0:
                track_length = lap_dist / lap_dist_pct
                
            # Compute distance to next brake/throttle points
            current_dist = lap_dist_pct * track_length
            dist_to_brake = 9999.0
            dist_to_throttle = 9999.0
            
            if self.braking_points:
                next_brake_dists = []
                for pct in self.braking_points:
                    d = pct * track_length
                    if d > current_dist:
                        next_brake_dists.append(d - current_dist)
                    else:
                        next_brake_dists.append((d + track_length) - current_dist)
                if next_brake_dists:
                    dist_to_brake = min(next_brake_dists)
                    
            if self.throttle_points:
                next_throttle_dists = []
                for pct in self.throttle_points:
                    d = pct * track_length
                    if d > current_dist:
                        next_throttle_dists.append(d - current_dist)
                    else:
                        next_throttle_dists.append((d + track_length) - current_dist)
                if next_throttle_dists:
                    dist_to_throttle = min(next_throttle_dists)
                    
            # Compute lateral deviation (racing line offset) using self-calibrating projected coordinates
            lateral_deviation = 0.0
            
            ref_x_metric = ref_point.get("x_metric", 0.0)
            ref_z_metric = ref_point.get("z_metric", 0.0)
            
            is_driving = raw_data.get("speed", 0.0) > 10.0
            
            if is_driving and user_x != 0.0 and user_z != 0.0:
                self.align_live_pts.append((user_x, user_z))
                self.align_ref_pts.append((ref_x_metric, ref_z_metric))
                
                # Keep sliding window of 180 points (approx 3 seconds of driving data)
                if len(self.align_live_pts) > 180:
                    self.align_live_pts.pop(0)
                    self.align_ref_pts.pop(0)
                    
                # Calculate span of points to ensure we are moving and have heading diversity
                first_pt = self.align_live_pts[0]
                last_pt = self.align_live_pts[-1]
                span = ((last_pt[0] - first_pt[0])**2 + (last_pt[1] - first_pt[1])**2)**0.5
                
                if len(self.align_live_pts) >= 10 and span > 20.0:
                    N = len(self.align_live_pts)
                    mean_x_live = sum(p[0] for p in self.align_live_pts) / N
                    mean_z_live = sum(p[1] for p in self.align_live_pts) / N
                    mean_x_ref = sum(p[0] for p in self.align_ref_pts) / N
                    mean_z_ref = sum(p[1] for p in self.align_ref_pts) / N
                    
                    A = 0.0
                    B = 0.0
                    for j in range(N):
                        x_l_c = self.align_live_pts[j][0] - mean_x_live
                        z_l_c = self.align_live_pts[j][1] - mean_z_live
                        x_r_c = self.align_ref_pts[j][0] - mean_x_ref
                        z_r_c = self.align_ref_pts[j][1] - mean_z_ref
                        
                        A += x_l_c * x_r_c + z_l_c * z_r_c
                        B += x_l_c * z_r_c - z_l_c * x_r_c
                        
                    self.align_theta = math.atan2(B, A)
                    self.align_dx = mean_x_live - (mean_x_ref * math.cos(self.align_theta) - mean_z_ref * math.sin(self.align_theta))
                    self.align_dz = mean_z_live - (mean_x_ref * math.sin(self.align_theta) + mean_z_ref * math.cos(self.align_theta))
                    self.aligned = True

            if self.aligned and user_x != 0.0 and user_z != 0.0:
                cos_t = math.cos(self.align_theta)
                sin_t = math.sin(self.align_theta)
                
                # Project current reference point
                ref_x_proj = ref_x_metric * cos_t - ref_z_metric * sin_t + self.align_dx
                ref_z_proj = ref_x_metric * sin_t + ref_z_metric * cos_t + self.align_dz
                
                # Project adjacent reference points to compute heading vector
                prev_ref = self.reference_lap[(ref_idx - 1) % num_points]
                next_ref = self.reference_lap[(ref_idx + 1) % num_points]
                
                prev_x_metric = prev_ref.get("x_metric", ref_x_metric)
                prev_z_metric = prev_ref.get("z_metric", ref_z_metric)
                next_x_metric = next_ref.get("x_metric", ref_x_metric)
                next_z_metric = next_ref.get("z_metric", ref_z_metric)
                
                prev_x_proj = prev_x_metric * cos_t - prev_z_metric * sin_t + self.align_dx
                prev_z_proj = prev_x_metric * sin_t + prev_z_metric * cos_t + self.align_dz
                next_x_proj = next_x_metric * cos_t - next_z_metric * sin_t + self.align_dx
                next_z_proj = next_x_metric * sin_t + next_z_metric * cos_t + self.align_dz
                
                heading_x = next_x_proj - prev_x_proj
                heading_z = next_z_proj - prev_z_proj
                length = (heading_x**2 + heading_z**2)**0.5
                
                if length > 0.001:
                    heading_x /= length
                    heading_z /= length
                    
                    # Right perpendicular vector: (hz, -hx)
                    right_x = heading_z
                    right_z = -heading_x
                    
                    diff_x = ref_x_proj - user_x
                    diff_z = ref_z_proj - user_z
                    
                    # Positive if reference is to the right of user, negative if left
                    lateral_deviation = diff_x * right_x + diff_z * right_z
            
            # Compute distance to next gear shift
            dist_to_shift = 9999.0
            shift_type = ""
            if self.shift_points:
                next_shift_dists = []
                for pct, s_type in self.shift_points:
                    d = pct * track_length
                    if d > current_dist:
                        next_shift_dists.append((d - current_dist, s_type))
                    else:
                        next_shift_dists.append(((d + track_length) - current_dist, s_type))
                if next_shift_dists:
                    closest_dist, closest_type = min(next_shift_dists, key=lambda x: x[0])
                    dist_to_shift = closest_dist
                    shift_type = closest_type

            comparison = {
                "hasReference": True,
                "refThrottle": ref_point["throttle"],
                "refBrake": ref_point["brake"],
                "refSpeed": ref_point["speed"] * 3.6, # Convert m/s to km/h
                "refGear": ref_point.get("gear", 0),
                "delta": delta_time,
                "distToBrake": dist_to_brake,
                "distToThrottle": dist_to_throttle,
                "distToShift": dist_to_shift,
                "shiftType": shift_type,
                "lateralDeviation": lateral_deviation,
                "refBrakeActive": ref_point["brake"] > 0.05,
                "refThrottleActive": ref_point["throttle"] > 0.05
            }

        # 4. Construct final telemetry payload
        payload = {
            "type": "telemetry",
            "connected": True,
            "is_mock": self.use_mock,
            "data": {
                "lap": lap,
                "lapDistPct": lap_dist_pct,
                "lapDist": raw_data["lapDist"],
                "throttle": raw_data["throttle"],
                "brake": raw_data["brake"],
                "speed": raw_data["speed"],
                "gear": raw_data["gear"],
                "sessionTime": session_time,
                "userLapTime": user_lap_time,
                **comparison
            }
        }
        
        return payload

    async def handler(self, websocket, *args):
        await self.register_client(websocket)
        try:
            async for message in websocket:
                data = json.loads(message)
                command = data.get("command")
                
                if command == "parse_ibt":
                    file_path = data.get("filePath")
                    print(f"Request to parse IBT: {file_path}")
                    try:
                        # Extract laps metadata
                        laps = parse_ibt_file(file_path)
                        # Cache raw laps data in-memory so we don't have to parse the file twice
                        self.parsed_ibt_cache[file_path] = laps
                        
                        # Return list of laps to client (stripping raw sample lists to keep packet light)
                        laps_meta = []
                        for lap in laps:
                            laps_meta.append({
                                "lap_num": lap["lap_num"],
                                "lap_time_str": lap["lap_time_str"],
                                "lap_time": lap["lap_time"]
                            })
                            
                        await websocket.send(json.dumps({
                            "type": "ibt_laps",
                            "filePath": file_path,
                            "laps": laps_meta
                        }))
                    except Exception as e:
                        traceback.print_exc()
                        await websocket.send(json.dumps({
                            "type": "error",
                            "message": f"Failed to parse IBT file: {str(e)}"
                        }))
                        
                elif command == "select_ibt_lap":
                    file_path = data.get("filePath")
                    lap_num = int(data.get("lapNum"))
                    print(f"Request to select lap {lap_num} from IBT: {file_path}")
                    
                    try:
                        laps = self.parsed_ibt_cache.get(file_path)
                        if not laps:
                            # Re-parse if cache cleared
                            laps = parse_ibt_file(file_path)
                            self.parsed_ibt_cache[file_path] = laps
                            
                        selected_lap = next((l for l in laps if l["lap_num"] == lap_num), None)
                        if selected_lap:
                            # Interpolate lap samples to standard grid
                            interpolated = interpolate_lap_data(selected_lap["samples"])
                            self.set_reference_lap(interpolated, lap_num, selected_lap["lap_time_str"])
                            
                            # Broadcast to all clients
                            await self.broadcast(json.dumps({
                                "type": "reference_loaded",
                                "lapNum": self.reference_lap_num,
                                "lapTimeStr": self.reference_lap_time_str
                            }))
                        else:
                            await websocket.send(json.dumps({
                                "type": "error",
                                "message": f"Lap {lap_num} not found in this session."
                            }))
                    except Exception as e:
                        traceback.print_exc()
                        await websocket.send(json.dumps({
                            "type": "error",
                            "message": f"Failed to load lap: {str(e)}"
                        }))
                        
                elif command == "start_recording":
                    print("Starting telemetry recording...")
                    self.recorded_ticks = []
                    self.is_recording = True
                    await websocket.send(json.dumps({
                        "type": "recording_state",
                        "recording": True
                    }))
                    
                elif command == "stop_recording":
                    file_name = data.get("fileName", "recorded_lap")
                    print(f"Stopping telemetry recording. Saving to {file_name}...")
                    self.is_recording = False
                    
                    try:
                        if len(self.recorded_ticks) < 100:
                            raise ValueError("Too few samples recorded. Drive at least one complete lap.")
                            
                        # Group recorded ticks by lap
                        laps_raw = {}
                        for tick in self.recorded_ticks:
                            # Ensure we have lap numbers
                            # Mock simulator has "lap", wait in mock ticks it is simulated.
                            # Ticks recorded are: time, distPct, throttle, brake, speed.
                            # We can infer lap number based on distPct wrap-around or if they contain lap number.
                            # Let's verify: tick format in get_telemetry_tick adds lap?
                            # Ah, looking at self.recorded_ticks.append: we only stored time, distPct, throttle, brake, speed.
                            # Let's check which lap it belongs to.
                            # Let's rewrite tick recording to include lap!
                            pass
                            
                        # Actually, let's keep it simple: we can slice the recorded ticks into laps.
                        # Since we recorded continuously, we look at distPct. Every time distPct decreases significantly,
                        # it indicates a lap boundary!
                        laps_sliced = []
                        current_lap = []
                        last_pct = 0.0
                        
                        for tick in self.recorded_ticks:
                            pct = tick["distPct"]
                            if pct < last_pct - 0.5: # lap boundary!
                                if len(current_lap) > 100:
                                    laps_sliced.append(current_lap)
                                current_lap = []
                            current_lap.append(tick)
                            last_pct = pct
                        if len(current_lap) > 100:
                            laps_sliced.append(current_lap)
                            
                        if not laps_sliced:
                            raise ValueError("No complete lap was recorded. Drive a full lap.")
                            
                        # Find the fastest complete lap among the sliced laps
                        # A lap is complete if it goes from near 0 to near 1
                        valid_laps = []
                        for idx, lap in enumerate(laps_sliced):
                            if lap[0]["distPct"] < 0.1 and lap[-1]["distPct"] > 0.9:
                                duration = lap[-1]["time"] - lap[0]["time"]
                                valid_laps.append((duration, lap))
                                
                        if not valid_laps:
                            raise ValueError("No complete lap recorded. Drive a full lap starting from start/finish line.")
                            
                        # Pick the fastest valid lap
                        fastest_duration, fastest_lap_ticks = min(valid_laps, key=lambda x: x[0])
                        
                        # Interpolate
                        interpolated = interpolate_lap_data(fastest_lap_ticks)
                        
                        # Create directory if it doesn't exist
                        # Save in Documents/iRacingTelemetryOverlay/laps/
                        user_documents = os.path.expanduser("~/Documents")
                        out_dir = os.path.join(user_documents, "iRacingTelemetryOverlay", "laps")
                        os.makedirs(out_dir, exist_ok=True)
                        
                        full_path = os.path.join(out_dir, f"{file_name}.json")
                        with open(full_path, "w") as f_out:
                            json.dump({
                                "duration": fastest_duration,
                                "points": interpolated
                            }, f_out, indent=2)
                            
                        print(f"Saved recorded lap to {full_path}")
                        
                        # Set as current reference
                        minutes = int(fastest_duration // 60)
                        seconds = int(fastest_duration % 60)
                        ms = int((fastest_duration % 1) * 1000)
                        time_str = f"{minutes:02d}:{seconds:02d}.{ms:03d}"
                        self.set_reference_lap(interpolated, "Rec", time_str)
                        
                        await self.broadcast(json.dumps({
                            "type": "reference_loaded",
                            "lapNum": self.reference_lap_num,
                            "lapTimeStr": self.reference_lap_time_str
                        }))
                        
                        await websocket.send(json.dumps({
                            "type": "recording_saved",
                            "fileName": f"{file_name}.json",
                            "filePath": full_path
                        }))
                    except Exception as e:
                        traceback.print_exc()
                        await websocket.send(json.dumps({
                            "type": "error",
                            "message": f"Failed to process/save recording: {str(e)}"
                        }))
                    finally:
                        self.recorded_ticks = []
                        await websocket.send(json.dumps({
                            "type": "recording_state",
                            "recording": False
                        }))
                        
                elif command == "unload_reference":
                    print("Unloading reference lap...")
                    self.set_reference_lap(None, None, None)
                    await self.broadcast(json.dumps({
                        "type": "reference_unloaded"
                    }))
                    
        except websockets.exceptions.ConnectionClosedError:
            pass
        finally:
            await self.unregister_client(websocket)

    async def telemetry_loop(self):
        """
        Loop that broadcasts telemetry at 60Hz.
        """
        dt = 1/60.0
        while True:
            try:
                tick_data = self.get_telemetry_tick()
                await self.broadcast(json.dumps(tick_data))
            except Exception as e:
                print(f"Error in telemetry loop: {e}")
                traceback.print_exc()
            await asyncio.sleep(dt)

    async def start(self):
        print(f"Starting WebSocket server on {self.host}:{self.port}...")
        self.init_irsdk()
        
        async with websockets.serve(self.handler, self.host, self.port):
            await self.telemetry_loop()

if __name__ == "__main__":
    bridge = TelemetryBridge()
    # Check if user forced mock mode via command line
    if "--mock" in sys.argv:
        bridge.use_mock = True
    elif "--live" in sys.argv:
        bridge.use_mock = False
        
    asyncio.run(bridge.start())
