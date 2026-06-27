import time
import math

class MockTelemetryGenerator:
    def __init__(self, track_length=4000.0):
        self.track_length = track_length
        self.lap = 1
        self.lap_dist = 0.0
        self.lap_dist_pct = 0.0
        self.speed = 15.0  # start at 15 m/s (54 km/h)
        self.session_time = 0.0
        self.gear = 1
        
        # Physics constants
        self.max_accel = 5.5      # m/s^2 max acceleration
        self.max_braking = 22.0   # m/s^2 max braking
        self.drag_coeff = 0.0008  # aerodynamic drag
        
        # Track definition: list of corners with (start_dist, apex_dist, end_dist, apex_speed)
        # We will simulate a simple 3-corner track
        self.corners = [
            (800.0, 950.0, 1100.0, 18.0),   # T1: Slow hairpin
            (2000.0, 2150.0, 2300.0, 28.0), # T2: Medium speed corner
            (3200.0, 3350.0, 3500.0, 38.0)  # T3: Fast sweep
        ]

    def get_inputs_for_position(self, dist):
        """
        Determines target throttle and brake based on track position and upcoming corners.
        """
        # Look ahead to find if we need to brake for an upcoming corner
        for start, apex, end, apex_speed in self.corners:
            # We are approaching a corner
            if dist < apex:
                # Calculate braking distance needed to slow down from current speed to apex speed
                if self.speed > apex_speed:
                    required_decel = (self.speed**2 - apex_speed**2) / (2 * (apex - dist + 0.1))
                    if required_decel > 2.0:
                        # We need to brake!
                        # Calculate brake pressure (max out at 0.95, trail off near apex)
                        dist_to_apex = apex - dist
                        brake = min(0.95, required_decel / self.max_braking)
                        
                        # In the final 20% of braking zone, simulate trail braking
                        total_braking_zone = apex - start
                        if dist > start and total_braking_zone > 0:
                            pct_through_zone = (dist - start) / total_braking_zone
                            if pct_through_zone > 0.8:
                                # Fade brake from max to 0.1
                                brake = brake * (1.0 - (pct_through_zone - 0.8) / 0.2)
                        
                        return 0.0, max(0.0, brake)
            
            # We are inside the corner apex / exit
            if start <= dist <= end:
                if dist < apex:
                    # Still in entry/apex
                    return 0.0, 0.0
                else:
                    # Exiting corner: roll on throttle
                    exit_pct = (dist - apex) / (end - apex)
                    return max(0.2, exit_pct * 1.0), 0.0

        # Straights
        return 1.0, 0.0

    def update(self, dt=1/60.0):
        """
        Updates the physics state of the car by one time step (dt).
        """
        self.session_time += dt
        
        # Get driver inputs based on current position
        throttle, brake = self.get_inputs_for_position(self.lap_dist)
        
        # Physics update
        # 1. Acceleration force
        accel_force = throttle * self.max_accel * (1.0 - (self.speed / 80.0)) # engine power drops at high speed
        # 2. Braking force
        brake_force = brake * self.max_braking
        # 3. Aero drag
        drag_force = self.drag_coeff * (self.speed ** 2)
        
        # Net acceleration
        net_accel = accel_force - brake_force - drag_force
        
        # Update speed (don't go backwards, clamp max speed)
        self.speed = max(2.0, min(75.0, self.speed + net_accel * dt))
        
        # Update distance
        self.lap_dist += self.speed * dt
        
        # Check lap completion
        if self.lap_dist >= self.track_length:
            self.lap_dist = self.lap_dist % self.track_length
            self.lap += 1
            
        self.lap_dist_pct = self.lap_dist / self.track_length
        
        # Simple gear simulation based on speed
        if self.speed < 12.0:
            self.gear = 1
        elif self.speed < 22.0:
            self.gear = 2
        elif self.speed < 35.0:
            self.gear = 3
        elif self.speed < 48.0:
            self.gear = 4
        elif self.speed < 60.0:
            self.gear = 5
        else:
            self.gear = 6
            
        # Generate world coordinates (circular track representation)
        theta = self.lap_dist_pct * 2 * math.pi
        # Reference is a perfect circle of radius 636.62m
        # User wanders slightly (inner and outer) compared to the reference track
        # to simulate a non-zero racing line lateral offset
        user_radius = 636.62 + 3.0 * math.sin(theta * 6)
        x = user_radius * math.cos(theta)
        z = user_radius * math.sin(theta)
        y = 0.0

        return {
            "lap": self.lap,
            "lapDistPct": self.lap_dist_pct,
            "lapDist": self.lap_dist,
            "throttle": throttle,
            "brake": brake,
            "speed": self.speed * 3.6,  # Convert m/s to km/h for display
            "gear": self.gear,
            "sessionTime": self.session_time,
            "PlayerCarIdx": 0,
            "CarIdxPosX": [x] + [0.0] * 63,
            "CarIdxPosY": [y] + [0.0] * 63,
            "CarIdxPosZ": [z] + [0.0] * 63
        }

if __name__ == "__main__":
    # Test simulator
    sim = MockTelemetryGenerator()
    for _ in range(120):
        state = sim.update(1/60.0)
        print(f"Dist: {state['lapDist']:.1f}m | Speed: {state['speed']:.1f}km/h | Thr: {state['throttle']:.2f} | Brk: {state['brake']:.2f} | Gear: {state['gear']}")
        time.sleep(1/60.0)
