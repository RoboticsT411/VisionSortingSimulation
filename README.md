# Project 1 – Vision sorting simulator (online)

The EEE-7-ROB Project 1 station in a web browser: Niryo One, platform with ArUco markers,
squares A, B, C, foam cubes and the station camera. The project's Python programs run
unchanged in the browser (Pyodide), with their OpenCV and Tk windows, keys, mouse clicks,
robot commands and `input()`.

## Publishing on GitHub Pages

1. Create a repository (for example `roboticst411/VisionSortingSimulation`) and copy the
   contents of this folder into it. Do **not** copy `vendor/` (local testing only) or
   `project/staff.json` (it contains the answers).
2. Settings → Pages → Deploy from branch → `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repository>/`. The first visit reloads once:
   `coi-serviceworker.js` turns on cross-origin isolation, which Python needs to wait
   for keys and robot moves (GitHub Pages cannot send those headers itself).

Python (Pyodide 0.26.4 with OpenCV, scikit-learn, SciPy and matplotlib, about 60 MB) is
loaded from the jsDelivr CDN on first use and cached by the browser.

## For students

Nothing to install: open the link in Chrome or Edge on a PC (Firefox works except voice).
The first visit reloads once, then downloads Python (about 60 MB, cached afterwards).
Files are kept in the student's own browser; download and upload them as a .zip.

Labs 1 to 4 are included, each in its own folder (`LAB-1/main.py` … `LAB-4/main.py` in the
Run list). Every robot address connects to the one simulated arm. Lab 4's `keyboard` module
reads keys pressed on the page, except while typing in a text box.

## Updating the student files

The program files come from `project/student.json`, built from the student package:

    python build_site.py            # student package only, for publishing
    python build_site.py --staff    # also staff.json, for local testing with ?pkg=staff

`build_site.py` appends the simulator's settings to `config.py` (robot "Simulator",
20 mm cubes, camera position) and adds `stations/simulator.json` (Lab 5 positions).

## Testing locally

    python serve.py site 8765       # serves with the cross-origin isolation headers
                                    # (from inside the unzipped site: python serve.py . 8765)
    open http://127.0.0.1:8765/index.html            (student files)
    open http://127.0.0.1:8765/index.html?pkg=staff  (staff files)

With a local `vendor/pyodide/` folder (the Pyodide 0.26.4 release unpacked), Python is
loaded from it on 127.0.0.1; add `?cdn` to use jsDelivr instead.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout and help |
| `app.js` | Connects Python, the station and the windows; Run/Stop, terminal, editor, files, voice |
| `scene.js` | 3D station, gripper, grasping and stacking, station camera |
| `arm.js` | Niryo One: Niryo's joint chain, inverse kinematics, link and Gripper 1 meshes |
| `ui.js` | OpenCV windows, Tk windows, message boxes |
| `worker.js` | Runs Python; blocking calls through shared memory |
| `py/` | Python stand-ins: camera and windows (`browser_cv2.py`), robot client (`niryo_one_tcp_client.py`), Tk (`tkinter/`), voice (`voice_commands.py`), start-up (`browser_boot.py`) |
| `lib/` | three.js, OrbitControls, BufferGeometryUtils, fflate; `lib/niryo/` the Niryo One meshes |

## Credits

Niryo One kinematics and meshes: [NiryoRobotics/niryo_one_ros](https://github.com/NiryoRobotics/niryo_one_ros) and [niryo_one](https://github.com/NiryoRobotics/niryo_one), GPL-3.0. The same arm is used in the Niryo One browser simulator.
