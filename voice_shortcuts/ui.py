"""Optional listening overlay (tkinter): Listening → Processing… → done."""
try:
    import tkinter as tk
except ImportError:
    tk = None

SPINNER = ("\u25d0", "\u25d3", "\u25d1", "\u25d2")


def has_ui():
    return tk is not None


def show_listening():
    """Show small 'Listening' window. Returns (root, icon_label, text_label) or (None, None, None)."""
    if tk is None:
        return None, None, None
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    root.overrideredirect(True)
    root.resizable(False, False)
    root.configure(bg="#252526")
    f = tk.Frame(root, bg="#252526", padx=24, pady=20)
    f.pack()
    icon_label = tk.Label(f, text="\U0001f3a4", font=("Sans", 24), fg="#ec5f5f", bg="#252526")
    icon_label.pack()
    text_label = tk.Label(f, text="Listening…", font=("Sans", 10), fg="#858585", bg="#252526")
    text_label.pack(pady=(4, 0))
    root.update_idletasks()
    w, h = max(140, root.winfo_reqwidth()), root.winfo_reqheight()
    root.geometry(f"{w}x{h}+{root.winfo_screenwidth() // 2 - w // 2}+{root.winfo_screenheight() // 3 - h // 2}")
    root.deiconify()
    return root, icon_label, text_label


def switch_to_processing(icon_label, text_label):
    """Update overlay to 'Processing…' with animated spinner."""
    if icon_label is None:
        return
    icon_label.config(text=SPINNER[0], fg="#569cd6")
    text_label.config(text="Processing…")


def animate_spinner(icon_label, is_running):
    """Call from main thread: advance spinner while is_running() is True."""
    if icon_label is None:
        return
    idx = [0]

    def tick():
        if is_running():
            idx[0] = (idx[0] + 1) % len(SPINNER)
            icon_label.config(text=SPINNER[idx[0]])
            icon_label.after(120, tick)

    icon_label.after(120, tick)


def destroy(root):
    if root:
        try:
            root.destroy()
        except Exception:
            pass
