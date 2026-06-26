# TrueLine

> **A FromRigToRoad performance product**

TrueLine is a premium, real-time telemetry overlay application for iRacing. It displays a transparent, click-through HUD overlay directly on top of the simulator, comparing your live throttle, brake, speed, and gear inputs side-by-side with a coach's reference lap (parsed from standard `.ibt` telemetry logs) in real time.

---

## Key Features

* **Dual HUD Display Modes:**
  * **HUD Bars:** Side-by-side vertical inputs (gas/brake) with a needle marker showing the reference driver's inputs at the exact same track position.
  * **VRS Rolling Chart:** A high-performance canvas scrolling time-series graph plotting your live inputs (solid lines) and reference inputs (dashed lines) at 60Hz.
* **Smart `.ibt` Parser:** Group binary logs by lap, filter out incomplete/aborted laps, and select reference laps from a dropdown.
* **Real-Time Delta Display:** Large glowing digital clock showing live time gains/losses (e.g., `-0.14s` in neon green or `+0.32s` in neon red).
* **Speed Delta Indicator:** Shows live speed difference relative to reference (e.g., `▲ +3 km/h`).
* **Aspect-Locked Window Resizing:** Locked 1.8 aspect ratio with dynamic, high-resolution vector and text scaling that remains sharp and fits the window bounds perfectly.
* **Interactive Lock State:** Toggles click-through mode (`🔒 Locked`) so it doesn't capture clicks in-game, and draggable mode (`🔓 Unlocked`) to reposition and resize the HUD on the fly.

---

## How to Run locally (Development)

### 1. Prerequisites
Ensure you have **Node.js 18+** and **Python 3.9+** installed on your system.

### 2. Installation
Open a terminal in the project folder and run:
```bash
# Install Node dependencies
npm install

# Set up Python virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: .\venv\Scripts\activate

# Install Python requirements
pip install -r backend/requirements.txt
```

### 3. Launch Development Server
```bash
npm run electron:dev
```
This launches the WebSocket telemetry bridge and opens both the Dashboard Control Panel and the HUD overlay. The app defaults to simulated mock telemetry if iRacing is not running or if you are running on macOS/Linux.

---

## 📦 How to Release to Subscribers (CI/CD Setup)

The repository includes a fully automated **GitHub Actions CI/CD release workflow** inside `.github/workflows/release.yml`. When you publish a release version on GitHub, GitHub's cloud runners will automatically build the Windows binaries for you.

### Publishing a Release via GitHub
1. Create a version tag and push it to GitHub:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
2. Go to your repository page's **Actions** tab to watch the build pipeline run.
3. Once completed, a new draft release will be created under **Releases**, and the standalone Windows installer (`TrueLine Setup 1.0.0.exe`) and portable zip will be automatically attached as assets for download.
