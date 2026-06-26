import asyncio
import json
import os
import sys
import traceback
import websockets
from mock_sim import MockTelemetryGenerator
from ibt_parser import parse_ibt_file, interpolate_lap_data

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
        
        # Recording state
        self.is_recording = False
        self.recorded_ticks = []
        
        # Lap timing variables
        self.last_lap = -1
        self.lap_start_time = 0.0
        
        # Cache for parsed IBT files
        # key: file_path, value: list of lap dicts
        self.parsed_ibt_cache = {}

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
                        "sessionTime": self.ir["SessionTime"]
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

        # 2. Record tick if enabled
        if self.is_recording:
            self.recorded_ticks.append({
                "time": session_time,
                "distPct": lap_dist_pct,
                "throttle": raw_data["throttle"],
                "brake": raw_data["brake"],
                "speed": raw_data["speed"] / 3.6,  # store in m/s
                "gear": raw_data["gear"]
            })

        # 3. Calculate comparison telemetry if reference is loaded
        comparison = {
            "hasReference": False
        }
        
        if self.reference_lap and 0.0 <= lap_dist_pct <= 1.0:
            num_points = len(self.reference_lap)
            # Find closest reference index
            ref_idx = min(num_points - 1, max(0, int(lap_dist_pct * (num_points - 1))))
            ref_point = self.reference_lap[ref_idx]
            
            # Time delta calculation: user_lap_time - ref_lap_time at this distance
            delta_time = user_lap_time - ref_point["time"]
            
            comparison = {
                "hasReference": True,
                "refThrottle": ref_point["throttle"],
                "refBrake": ref_point["brake"],
                "refSpeed": ref_point["speed"] * 3.6, # Convert m/s to km/h
                "refGear": ref_point.get("gear", 0),
                "delta": delta_time
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
                            self.reference_lap = interpolate_lap_data(selected_lap["samples"])
                            self.reference_lap_num = lap_num
                            self.reference_lap_time_str = selected_lap["lap_time_str"]
                            
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
                        self.reference_lap = interpolated
                        self.reference_lap_num = "Rec"
                        minutes = int(fastest_duration // 60)
                        seconds = int(fastest_duration % 60)
                        ms = int((fastest_duration % 1) * 1000)
                        self.reference_lap_time_str = f"{minutes:02d}:{seconds:02d}.{ms:03d}"
                        
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
                    self.reference_lap = None
                    self.reference_lap_num = None
                    self.reference_lap_time_str = None
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
