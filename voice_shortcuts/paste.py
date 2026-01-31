"""Copy text to clipboard. Wayland: wl-copy; X11: xclip/xsel."""
import os
import subprocess


def copy_to_clipboard(text):
    """Copy text to clipboard. Returns True on success."""
    text = (text or "").strip()
    if not text:
        return False
    if os.environ.get("XDG_SESSION_TYPE") == "wayland":
        try:
            p = subprocess.Popen(
                ["wl-copy"],
                stdin=subprocess.PIPE,
                text=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            p.stdin.write(text)
            p.stdin.close()
            p.wait(timeout=1)
            return True
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            return False
    for cmd in (["xclip", "-selection", "clipboard"], ["xsel", "--clipboard"]):
        try:
            subprocess.run(cmd, input=text, text=True, capture_output=True, timeout=2, check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            continue
    return False
