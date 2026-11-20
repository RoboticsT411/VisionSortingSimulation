"""Stand-in for niryo_one_tcp_client: the same calls, answered by the robot simulated in the page."""
import browser_bridge as bb


class RobotTool:
    NONE = 0
    GRIPPER_1 = 11
    GRIPPER_2 = 12
    GRIPPER_3 = 13
    VACUUM_PUMP_1 = 31
    ELECTROMAGNET_1 = 30


class CalibrateMode:
    AUTO = 1
    MANUAL = 2


class RobotAxis:
    X, Y, Z, ROLL, PITCH, YAW = range(6)


class PoseObject:
    def __init__(self, x, y, z, roll, pitch, yaw):
        self.x, self.y, self.z, self.roll, self.pitch, self.yaw = x, y, z, roll, pitch, yaw

    def to_list(self):
        return [self.x, self.y, self.z, self.roll, self.pitch, self.yaw]

    def __repr__(self):
        return "PoseObject(" + ", ".join(f"{v:.4f}" for v in self.to_list()) + ")"


class NiryoOneClient:
    def __init__(self, timeout=5):
        self.connected = False

    def _cmd(self, cmd, *args):
        r = bb.request_json("robot", {"cmd": cmd, "args": [float(a) if isinstance(a, (int, float)) else a
                                                             for a in args]})
        return bool(r.get("ok")), r.get("data")

    def connect(self, ip):
        ok, data = self._cmd("connect", ip)
        if ok:
            print(f"Connected to server ({ip}) on port: 40001")
        else:
            print(f"Unable to connect to {ip}: {data}")
        self.connected = ok
        return ok

    def quit(self):
        self._cmd("quit")
        self.connected = False

    def calibrate(self, mode):
        return self._cmd("calibrate", mode)

    def change_tool(self, tool):
        return self._cmd("change_tool", tool)

    def open_gripper(self, tool, speed):
        return self._cmd("open_gripper", tool, speed)

    def close_gripper(self, tool, speed):
        return self._cmd("close_gripper", tool, speed)

    def move_pose(self, x, y, z, roll, pitch, yaw):
        return self._cmd("move_pose", x, y, z, roll, pitch, yaw)

    def shift_pose(self, axis, value):
        return self._cmd("shift_pose", axis, value)

    def move_joints(self, *joints):
        if len(joints) == 1 and isinstance(joints[0], (list, tuple)):
            joints = joints[0]
        return self._cmd("move_joints", *joints)

    def get_pose(self):
        ok, data = self._cmd("get_pose")
        return (ok, PoseObject(*data)) if ok else (ok, data)

    def get_joints(self):
        return self._cmd("get_joints")

    def set_learning_mode(self, enabled):
        return self._cmd("set_learning_mode", bool(enabled))

    def wait(self, duration):
        """Waits duration seconds (as the real client)."""
        bb.sleep(float(duration))
        return True, None

    def get_learning_mode(self):
        return self._cmd("get_learning_mode")

    def set_arm_max_velocity(self, percentage):
        return self._cmd("set_arm_max_velocity", percentage)
