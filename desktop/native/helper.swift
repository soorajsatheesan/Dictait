// Dictait's native companion, for what Electron cannot do itself:
// global shortcuts with press *and* release (hold-to-talk), reading the focused text field
// (context, selection), sending ⌘V to the currently focused field, and describing
// microphones and the camera notch.
// It runs as a child of Dictait.app, so macOS applies the app's Accessibility permission.
//
//   dictait-helper serve            JSON lines on stdin/stdout (requests, replies, hotkey events)
//   dictait-helper paste|focus|inputs|screens   one-off commands, printing JSON
//   dictait-helper post-key <code> <modifiers…>   diagnostics: press, hold and release a key
import AppKit
import ApplicationServices
import Carbon
import CoreAudio

// MARK: - Output & Concurrency

let outputLock = NSLock()
func send(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    outputLock.unlock()
}

/// Serial queue for AX / paste / audio queries so slow accessibility IPC never stalls the main
/// RunLoop or delays Carbon hotkey press/release delivery.
let axQueue = DispatchQueue(label: "org.dictait.helper.ax")
let pollLock = NSLock()
var latestActiveWindowRequestID: Int = 0

// MARK: - Screens

func screens() -> [[String: Double]] {
    // Geometry in Electron's top-left coordinate space, including the camera notch.
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    return NSScreen.screens.map { screen in
        let frame = screen.frame
        var value: [String: Double] = [
            "x": frame.minX, "y": primaryHeight - frame.maxY, "width": frame.width, "height": frame.height,
            "menuBarHeight": frame.maxY - screen.visibleFrame.maxY, "notchWidth": 0, "notchHeight": 0
        ]
        if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            value["notchWidth"] = frame.width - left.width - right.width
            value["notchHeight"] = screen.safeAreaInsets.top
        }
        return value
    }
}

// MARK: - Clipboard Snapshot & Paste

struct ClipboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]
}

func snapshotClipboard() -> ClipboardSnapshot {
    let board = NSPasteboard.general
    let items: [[NSPasteboard.PasteboardType: Data]] = (board.pasteboardItems ?? []).compactMap { item in
        var map: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types {
            if let data = item.data(forType: type) {
                map[type] = data
            }
        }
        return map.isEmpty ? nil : map
    }
    return ClipboardSnapshot(items: items)
}

@discardableResult
func setClipboard(_ text: String) -> Int {
    let board = NSPasteboard.general
    guard !text.isEmpty else { return board.changeCount }
    if board.string(forType: .string) == text { return board.changeCount }
    board.clearContents()
    board.setString(text, forType: .string)
    return board.changeCount
}

func scheduleClipboardRestore(_ snapshot: ClipboardSnapshot, expectedChangeCount: Int) {
    // Wait briefly so slow web/Electron editors finish reading the pasteboard after ⌘V.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        let board = NSPasteboard.general
        guard board.changeCount == expectedChangeCount else { return }
        board.clearContents()
        guard !snapshot.items.isEmpty else { return }
        let restored = snapshot.items.map { dataByType -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in dataByType {
                item.setData(data, forType: type)
            }
            return item
        }
        board.writeObjects(restored)
    }
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags, pid: pid_t? = nil) -> Bool {
    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
    down.flags = flags
    up.flags = flags
    if let pid {
        down.postToPid(pid)
        up.postToPid(pid)
    } else {
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
    return true
}

func paste(pid: pid_t? = nil) -> Bool {
    guard AXIsProcessTrusted() else { return false }
    // Use HID event tap for the frontmost app (sandboxed/Electron/terminal apps can ignore postToPid);
    // use postToPid only for non-activating panels whose PID differs from frontmostApplication.
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let targetPid = (pid != nil && pid != frontPid) ? pid : nil
    let posted = postKey(9, flags: .maskCommand, pid: targetPid)
    usleep(15_000)
    return posted
}

// MARK: - Focused element

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func string(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}

func visibleWindows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}

func frontWindowOrder(_ pid: pid_t, in windows: [[String: Any]]) -> Int? {
    // Ignore status-bar / menu-bar extra windows (layer >= 25) so they never outrank floating panels.
    windows.firstIndex { item in
        guard (item[kCGWindowOwnerPID as String] as? Int) == Int(pid) else { return false }
        let layer = item[kCGWindowLayer as String] as? Int ?? 0
        return layer >= 0 && layer < 25
    }
}

/// AXMinimized does not tell whether a launcher panel is dismissed or on another Space.
/// Window-server on-screen geometry tells us whether the window is visible in the active Space.
func windowOrder(_ window: AXUIElement, _ pid: pid_t, in windows: [[String: Any]]) -> Int? {
    guard let rect = bounds(window) else { return nil }
    if let exact = windows.firstIndex(where: { item in
        guard (item[kCGWindowOwnerPID as String] as? Int) == Int(pid),
              let frame = item[kCGWindowBounds as String] as? [String: Double] else { return false }
        let layer = item[kCGWindowLayer as String] as? Int ?? 0
        guard layer >= 0 && layer < 25 else { return false }
        return [("x", "X"), ("y", "Y"), ("width", "Width"), ("height", "Height")].allSatisfy {
            abs((rect[$0.0] ?? -10000) - (frame[$0.1] ?? 10000)) < 12
        }
    }) {
        return exact
    }
    // Fallback for custom-chrome windows whose AX frame differs slightly from CGWindow bounds:
    // require strong center-point overlap with an on-screen window owned by the same PID.
    let cx = (rect["x"] ?? 0) + (rect["width"] ?? 0) / 2
    let cy = (rect["y"] ?? 0) + (rect["height"] ?? 0) / 2
    return windows.firstIndex { item in
        guard (item[kCGWindowOwnerPID as String] as? Int) == Int(pid),
              let frame = item[kCGWindowBounds as String] as? [String: Double] else { return false }
        let layer = item[kCGWindowLayer as String] as? Int ?? 0
        guard layer >= 0 && layer < 25,
              let fx = frame["X"], let fy = frame["Y"], let fw = frame["Width"], let fh = frame["Height"],
              fw > 10, fh > 10 else { return false }
        return cx >= fx && cx <= fx + fw && cy >= fy && cy <= fy + fh
    }
}

func focusedElement(windows: [[String: Any]]? = nil) -> AXUIElement? {
    let onScreen = windows ?? visibleWindows()
    var element: AXUIElement?
    let front = NSWorkspace.shared.frontmostApplication
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    if let candidate = elementAttribute(system, kAXFocusedUIElementAttribute) {
        var pid: pid_t = 0
        AXUIElementGetPid(candidate, &pid)
        // Non-activating panels (Raycast) can own keyboard focus while another app is
        // "frontmost". Accept their system focus only while that exact window is visible
        // in front of the active app; a dismissed panel can leave a stale AX reference.
        if let window = windowOf(candidate, pid), let order = windowOrder(window, pid, in: onScreen) {
            let frontOrder = front.flatMap { frontWindowOrder($0.processIdentifier, in: onScreen) }
            if pid == front?.processIdentifier || frontOrder == nil || order <= frontOrder! { element = candidate }
        }
    }
    if element == nil, let front {
        // The system-wide AX focus can keep pointing at Raycast after it closes.
        // Ask the active application first instead of trusting that stale reference.
        let application = AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.3)
        element = elementAttribute(application, kAXFocusedUIElementAttribute)
    }
    if let element { AXUIElementSetMessagingTimeout(element, 0.3) }
    return element
}

func bounds(_ element: AXUIElement) -> [String: Double]? {
    guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions), dimensions.width > 0, dimensions.height > 0 else { return nil }
    return ["x": point.x, "y": point.y, "width": dimensions.width, "height": dimensions.height]
}

func onScreenWindowBounds(_ window: AXUIElement?, _ pid: pid_t, in windows: [[String: Any]]) -> [String: Double]? {
    guard let window, windowOrder(window, pid, in: windows) != nil else { return nil }
    return bounds(window)
}

private var appIcons: [pid_t: String] = [:]

/// Lightweight identity for the live indicator. Never reads text or remembers a field.
func applicationInfo(_ pid: pid_t) -> [String: Any] {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return [:] }
    if appIcons[pid] == nil, let icon = app.icon,
       let cgImage = icon.cgImage(forProposedRect: nil, context: nil, hints: nil) {
        let size = 32
        if let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                               space: CGColorSpaceCreateDeviceRGB(),
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            ctx.interpolationQuality = .high
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: size, height: size))
            if let scaled = ctx.makeImage() {
                let bitmap = NSBitmapImageRep(cgImage: scaled)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    appIcons[pid] = "data:image/png;base64," + png.base64EncodedString()
                }
            }
        }
    }
    return ["app": app.bundleIdentifier ?? "", "appName": app.localizedName ?? "", "icon": appIcons[pid] ?? ""]
}

func activeWindowInfo() -> [String: Any] {
    let windows = visibleWindows()
    let element = AXIsProcessTrusted() ? focusedElement(windows: windows) : nil
    var pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    if let element { AXUIElementGetPid(element, &pid) }
    var destination = applicationInfo(pid)
    destination["editable"] = element.flatMap(editable) as Any? ?? NSNull()
    // Only return bounds if the window is actually on screen in the active Space, so a window
    // left open on Desktop 1 never pulls the HUD away from Desktop 2.
    let window = element.flatMap { windowOf($0, pid) } ?? (pid > 0 ? focusedWindow(pid) : nil)
    let rect = pid > 0 ? onScreenWindowBounds(window, pid, in: windows) : nil
    return ["bounds": rect as Any? ?? NSNull(), "destination": destination]
}

func selectedRange(_ element: AXUIElement) -> CFRange? {
    guard let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
}

@discardableResult
func setSelectedRange(_ element: AXUIElement, _ range: CFRange) -> Bool {
    var range = range
    guard let value = AXValueCreate(.cfRange, &range) else { return false }
    return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success
}

/// The element's whole text, when it is a reasonable size.
func wholeText(_ element: AXUIElement) -> NSString? {
    guard let whole = attribute(element, kAXValueAttribute) as? String else { return nil }
    let all = whole as NSString
    return all.length < 500_000 ? all : nil
}

/// The element's text in a range; some editors only expose their whole value, which is sliced.
func text(_ element: AXUIElement, in range: CFRange) -> String? {
    guard range.location >= 0, range.length >= 0 else { return nil }
    if range.length == 0 { return "" }
    var wanted = range
    if let parameter = AXValueCreate(.cfRange, &wanted) {
        var value: CFTypeRef?
        if AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, parameter, &value) == .success,
           let value = value as? String {
            return value
        }
    }
    guard let all = wholeText(element), range.location + range.length <= all.length else { return nil }
    return all.substring(with: NSRange(location: range.location, length: range.length))
}

func characterCount(_ element: AXUIElement) -> Int? {
    if let count = attribute(element, kAXNumberOfCharactersAttribute) as? Int { return count }
    return wholeText(element)?.length
}

/// The address of the web page holding an element, which tells one conversation, channel or
/// tab from another when an app reuses the same text box for all of them.
func page(of element: AXUIElement) -> String? {
    var current: AXUIElement? = element
    for _ in 0..<60 {
        guard let node = current else { return nil }
        if string(node, kAXRoleAttribute) == "AXWebArea" {
            return (attribute(node, kAXURLAttribute) as? URL)?.absoluteString ?? ""
        }
        current = elementAttribute(node, kAXParentAttribute)
    }
    return nil
}

let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
let controlRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor",
    "AXList", "AXOutline", "AXTable", "AXBrowser", "AXRow", "AXCell", "AXImage", "AXScrollArea", "AXSplitGroup",
    "AXTabGroup", "AXToolbar", "AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem", "AXDockItem", "AXColorWell",
    "AXDisclosureTriangle", "AXLink", "AXLevelIndicator", "AXValueIndicator"
]

func hasEditableAncestor(_ element: AXUIElement) -> Bool {
    var names: CFArray?
    if AXUIElementCopyAttributeNames(element, &names) == .success,
       (names as? [String] ?? []).contains("AXEditableAncestor") {
        return true
    }
    return false
}

/// True for text fields, false for buttons, lists and other controls, nil when unsure.
func editable(_ element: AXUIElement) -> Bool? {
    if let enabled = attribute(element, kAXEnabledAttribute) as? Bool, !enabled { return false }
    let role = string(element, kAXRoleAttribute)
    if textRoles.contains(role) {
        var settable: DarwinBoolean = true
        if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, !settable.boolValue {
            return false
        }
        return true
    }
    if hasEditableAncestor(element) { return true }
    if role == "AXStaticText" {
        // WebKit/contentEditable editors often report an inner AXStaticText node as focused.
        var parent = elementAttribute(element, kAXParentAttribute)
        for _ in 0..<6 {
            guard let node = parent else { break }
            let parentRole = string(node, kAXRoleAttribute)
            if textRoles.contains(parentRole) || hasEditableAncestor(node) { return true }
            if parentRole == "AXWindow" || parentRole == "AXApplication" { break }
            parent = elementAttribute(node, kAXParentAttribute)
        }
        return false
    }
    return controlRoles.contains(role) ? false : nil
}

/// A text-field snapshot used for context and safe follow-up edits in the current field.
struct Place {
    let pid: pid_t
    var element: AXUIElement?
    let window: AXUIElement?
    var range: CFRange?
    var before = ""
    var selected = ""
    var page: String?
    var windowTitle = ""
}

/// Dictait's last insertion, for spoken follow-ups such as "hey, make that shorter".
var lastInsertion: Place?

func focusedWindow(_ pid: pid_t) -> AXUIElement? {
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.3)
    return elementAttribute(application, kAXFocusedWindowAttribute)
}

func windowOf(_ element: AXUIElement, _ pid: pid_t) -> AXUIElement? {
    if let window = elementAttribute(element, kAXWindowAttribute), !isGone(window) { return window }
    // WebKit can retain the old AXWindow after a launcher recreates its panel.
    var parent = elementAttribute(element, kAXParentAttribute)
    for _ in 0..<60 {
        guard let node = parent else { break }
        if ["AXWindow", "AXSystemDialog"].contains(string(node, kAXRoleAttribute)), !isGone(node) { return node }
        parent = elementAttribute(node, kAXParentAttribute)
    }
    return focusedWindow(pid)
}

func place(of element: AXUIElement, reading: Bool = true) -> Place? {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success, pid > 0 else { return nil }
    var found = Place(pid: pid, element: element, window: windowOf(element, pid), range: selectedRange(element))
    guard reading else { return found }
    found.page = page(of: element)
    found.windowTitle = found.window.map { string($0, kAXTitleAttribute) } ?? ""
    // Never read a secure field, including its selection and surrounding text.
    if string(element, kAXSubroleAttribute) == "AXSecureTextField" { return found }
    if let range = found.range {
        let start = max(0, range.location - 600)
        found.before = text(element, in: CFRange(location: start, length: range.location - start)) ?? ""
        found.selected = text(element, in: range) ?? ""
    }
    return found
}

/// Electron apps (Codex, Slack, T3 Code…) describe their text fields only to assistive apps
/// that ask. Dictait asks as each app comes to the front, so they are ready for ⌃Space.
var exposedApplications: Set<pid_t> = []

/// Returns true only when this call newly enabled accessibility on a previously-unexposed app.
@discardableResult
func exposeTextFields(_ pid: pid_t) -> Bool {
    guard AXIsProcessTrusted(), pid != getpid(), !exposedApplications.contains(pid) else { return false }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.3)
    // Electron debounces this request for two seconds. Repeating it on every focus change
    // restarts the countdown and can keep the editor's accessibility tree unavailable.
    var enabled = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
    if !enabled, let app = NSRunningApplication(processIdentifier: pid), usesChromium(app) {
        // Chromium browsers use the platform accessibility switch instead of Electron's flag.
        enabled = AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success
    }
    if enabled {
        exposedApplications.insert(pid)
    }
    return enabled
}

func usesChromium(_ app: NSRunningApplication) -> Bool {
    guard let bundle = app.bundleURL,
          let frameworks = try? FileManager.default.contentsOfDirectory(atPath: bundle.appendingPathComponent("Contents/Frameworks").path) else { return false }
    return frameworks.contains { name in
        let name = name.lowercased()
        return name.hasSuffix(".framework") && ["electron", "chromium", "chrome"].contains(where: name.contains)
    }
}

/// Read the current field for recognition context and selection editing. Reading focus
/// never captures a future paste destination or schedules deferred delivery.
func focus() -> [String: Any] {
    let front = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = [
        "app": front?.bundleIdentifier ?? "", "appName": front?.localizedName ?? "",
        "editable": NSNull(), "before": "", "selected": "", "window": ""
    ]
    guard AXIsProcessTrusted() else { return result }
    var focused = focusedElement()
    if focused.flatMap(editable) != true, let front {
        // Only wait briefly if accessibility was JUST enabled on this app for the first time.
        if exposeTextFields(front.processIdentifier) {
            _ = wait(0.25) { focused = focusedElement(); return focused.flatMap(editable) == true }
        }
    }
    guard let element = focused, let found = place(of: element) else {
        if let front, let window = focusedWindow(front.processIdentifier) {
            result["window"] = String(string(window, kAXTitleAttribute).prefix(200))
        }
        return result
    }
    let role = string(element, kAXRoleAttribute)
    result["role"] = role
    if let focusedApp = NSRunningApplication(processIdentifier: found.pid) {
        result["app"] = focusedApp.bundleIdentifier ?? ""
        result["appName"] = focusedApp.localizedName ?? ""
    }
    if let window = found.window { result["window"] = String(string(window, kAXTitleAttribute).prefix(200)) }
    let kind = editable(element)
    if let kind { result["editable"] = kind }
    guard kind == true, role != "AXWebArea" else { return result }
    if string(element, kAXSubroleAttribute) == "AXSecureTextField" {
        result["secure"] = true
        return result
    }
    result["selected"] = String(string(element, kAXSelectedTextAttribute).prefix(8000))
    result["before"] = found.before
    return result
}

// MARK: - Delivery at the current focus

func isGone(_ element: AXUIElement?) -> Bool {
    guard let element else { return false }
    var role: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .invalidUIElement
}

/// Waits up to `seconds` for a condition, checking every 20 ms.
func wait(_ seconds: Double, until condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() {
        if Date() >= deadline { return false }
        usleep(20_000)
    }
    return true
}

func normalizedTitle(_ title: String) -> String {
    var clean = title.trimmingCharacters(in: .whitespaces)
    for prefix in ["• ", "● ", "* "] {
        if clean.hasPrefix(prefix) { clean = String(clean.dropFirst(prefix.count)) }
    }
    for suffix in [" — Edited", " - Edited", " •"] {
        if clean.hasSuffix(suffix) { clean = String(clean.dropLast(suffix.count)) }
    }
    return clean
}

/// Identity checks protect follow-up edits; they never bring an old field into focus.
func matches(_ element: AXUIElement, _ target: Place) -> Bool {
    guard let field = target.element, CFEqual(element, field) else { return false }
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    guard pid == target.pid, target.page == nil || page(of: element) == target.page else { return false }
    if let window = target.window {
        guard let current = windowOf(element, pid), CFEqual(current, window) else { return false }
        let wanted = normalizedTitle(target.windowTitle)
        if !wanted.isEmpty, normalizedTitle(string(window, kAXTitleAttribute)) != wanted { return false }
    }
    return true
}

func isFocused(_ element: AXUIElement, _ target: Place) -> Bool {
    guard let current = focusedElement() else { return false }
    return CFEqual(current, element) && matches(current, target)
}

/// ⌘V into the focused element at `range` (or its own cursor), then notes where the words
/// landed for follow-ups. With `keepCursor`, a cursor the user had moved elsewhere in the same
/// box goes back there afterwards. Restores the user's previous clipboard after verified paste.
func paste(_ text: String, into element: AXUIElement?, of target: Place, at range: CFRange?, keepCursor: Bool = true) -> Bool {
    guard let element, isFocused(element, target) else { return false }
    let user = selectedRange(element)
    if let range, user.map({ $0.location != range.location || $0.length != range.length }) ?? true {
        guard setSelectedRange(element, range) else { return false }
        usleep(30_000)
    }
    let start = selectedRange(element)
    let beforeCount = characterCount(element)
    let savedClipboard = snapshotClipboard()
    let pasteChangeCount = setClipboard(text)
    // Setting the selection and clipboard can yield to the target app: verify again at ⌘V.
    guard isFocused(element, target) else { return false }
    guard paste(pid: target.pid) else { return false }
    lastInsertion = nil
    guard let start else {
        usleep(150_000) // Let ⌘V land before anything moves.
        scheduleClipboardRestore(savedClipboard, expectedChangeCount: pasteChangeCount)
        return true
    }
    // The app handles ⌘V on its own time; cursor motion, length change, or matching text confirms it.
    var end: CFRange?
    let acknowledged = wait(0.8) {
        if let now = selectedRange(element), now.location != start.location || now.length != start.length {
            end = now
            return true
        }
        if let beforeCount, let nowCount = characterCount(element), nowCount != beforeCount {
            return true
        }
        if selfTextMatches(text, element, start.location) {
            return true
        }
        return false
    }
    // Some custom editors/terminals expose a static {0,0} range and no AX text value at all.
    let opaqueField = start.location == 0 && start.length == 0 && beforeCount == nil && wholeText(element) == nil
    guard acknowledged || selfTextMatches(text, element, start.location) || (opaqueField && isFocused(element, target)) else {
        return false
    }
    scheduleClipboardRestore(savedClipboard, expectedChangeCount: pasteChangeCount)
    let inserted = end.map { $0.location - start.location } ?? (text as NSString).length
    if inserted > 0 {
        var landed = target
        landed.element = element
        landed.range = CFRange(location: start.location, length: inserted)
        lastInsertion = landed
    }
    if keepCursor, let user, user.location != start.location || user.length != start.length {
        let shift = user.location >= start.location + start.length ? inserted - start.length : 0
        setSelectedRange(element, CFRange(location: user.location + shift, length: user.length))
    }
    return true
}

func selfTextMatches(_ value: String, _ element: AXUIElement, _ location: Int) -> Bool {
    text(element, in: CFRange(location: location, length: (value as NSString).length)) == value
}

/// Insert into the field focused now. There is no remembered recording destination,
/// application activation, thread navigation or queue waiting for an old field to return.
func deliver(_ value: String) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["outcome": "untrusted"] }
    guard let element = focusedElement() else {
        lastInsertion = nil
        let saved = snapshotClipboard()
        let changeCount = setClipboard(value)
        let ok = paste()
        if ok { scheduleClipboardRestore(saved, expectedChangeCount: changeCount) }
        return ["outcome": ok ? "pasted" : "failed"]
    }
    if editable(element) == false { return ["outcome": "no-target"] }
    guard editable(element) == true, let current = place(of: element) else {
        lastInsertion = nil
        let saved = snapshotClipboard()
        let changeCount = setClipboard(value)
        let ok = paste()
        if ok { scheduleClipboardRestore(saved, expectedChangeCount: changeCount) }
        return ["outcome": ok ? "pasted" : "failed"]
    }
    let verifiable = selectedRange(element) != nil
    let pasted = paste(value, into: element, of: current, at: nil, keepCursor: false)
    return ["outcome": pasted ? "pasted" : "failed", "destination": pasted && verifiable ? applicationInfo(current.pid) : NSNull()]
}

func squashed(_ value: String) -> String {
    value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// A follow-up may replace the last insertion only while that same field has focus.
/// Otherwise the caller delivers the rewritten text to the user's current cursor.
func replaceLast(expected: String, replacement: String) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["outcome": "untrusted"] }
    guard let last = lastInsertion, let range = last.range, let element = last.element,
          isFocused(element, last) else { return ["outcome": "gone"] }
    guard squashed(text(element, in: range) ?? "") == squashed(expected) else { return ["outcome": "changed"] }
    let pasted = paste(replacement, into: element, of: last, at: range)
    return ["outcome": pasted ? "replaced" : "failed", "destination": pasted ? applicationInfo(last.pid) : NSNull()]
}

// MARK: - Microphones

func audioNumber(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
}

func inputs() -> [String: Any] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return ["devices": []] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return ["devices": []] }
    let fallback = audioNumber(system, kAudioHardwarePropertyDefaultInputDevice) ?? 0
    var devices: [[String: Any]] = []
    for id in ids {
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var length: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &length) == noErr, length > 0 else { continue }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(length), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &streams, 0, nil, &length, raw) == noErr else { continue }
        let buffers = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        guard buffers.reduce(0, { $0 + Int($1.mNumberChannels) }) > 0 else { continue }
        var name: Unmanaged<CFString>?
        var nameAddress = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &nameAddress, 0, nil, &nameSize, &name) == noErr, let title = name?.takeRetainedValue() as String? else { continue }
        let transport = audioNumber(id, kAudioDevicePropertyTransportType) ?? 0
        let kind: String
        switch transport {
        case kAudioDeviceTransportTypeBuiltIn: kind = "builtin"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: kind = "bluetooth"
        case kAudioDeviceTransportTypeUSB: kind = "usb"
        case kAudioDeviceTransportTypeVirtual, kAudioDeviceTransportTypeAggregate: kind = "virtual"
        default: kind = "other"
        }
        devices.append(["name": title, "transport": kind, "default": id == fallback])
    }
    return ["devices": devices]
}

// MARK: - Hotkeys (press and release)

final class HotKeys {
    private var references: [EventHotKeyRef] = []
    private var names: [UInt32: String] = [:]
    private var codes: [UInt32: CGKeyCode] = [:]
    private var held: [UInt32: CFAbsoluteTime] = [:]
    private var handler: EventHandlerRef?
    private var releaseWatcher: Timer?
    var onEvent: (String, Bool, Double) -> Void = { _, _, _ in }

    func install() {
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))
        ]
        let callback: EventHandlerUPP = { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            let keys = Unmanaged<HotKeys>.fromOpaque(context).takeUnretainedValue()
            var identifier = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &identifier)
            let at = (Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime + GetEventTime(event)) * 1000
            keys.handle(identifier.id, pressed: GetEventKind(event) == UInt32(kEventHotKeyPressed), at: at)
            return noErr
        }
        InstallEventHandler(GetApplicationEventTarget(), callback, 2, &types, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    private func handle(_ id: UInt32, pressed: Bool, at: Double) {
        guard let name = names[id] else { return }
        // Key auto-repeat sends repeated presses; report one down and one up.
        if pressed {
            guard held[id] == nil else { return }
            held[id] = CFAbsoluteTimeGetCurrent()
            ensureWatcher()
        } else {
            guard held.removeValue(forKey: id) != nil else { return }
            stopWatcherIfIdle()
        }
        onEvent(name, pressed, at)
    }

    /// Recover if macOS swallows a key-up event (secure input, sleep, Space switch, lock screen).
    private func ensureWatcher() {
        guard releaseWatcher == nil else { return }
        releaseWatcher = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.checkReleased()
        }
    }

    private func stopWatcherIfIdle() {
        if held.isEmpty {
            releaseWatcher?.invalidate()
            releaseWatcher = nil
        }
    }

    private func checkReleased() {
        let now = CFAbsoluteTimeGetCurrent()
        let wall = Date().timeIntervalSince1970 * 1000
        for (id, since) in held {
            guard now - since > 0.25, let code = codes[id] else { continue }
            let stillDown = CGEventSource.keyState(.combinedSessionState, key: code) || CGEventSource.keyState(.hidSystemState, key: code)
            if !stillDown, let name = names[id] {
                held.removeValue(forKey: id)
                onEvent(name, false, wall)
            }
        }
        stopWatcherIfIdle()
    }

    func releaseAll() {
        let wall = Date().timeIntervalSince1970 * 1000
        for id in Array(held.keys) {
            held.removeValue(forKey: id)
            if let name = names[id] { onEvent(name, false, wall) }
        }
        stopWatcherIfIdle()
    }

    /// Registers [{name, code, modifiers: ["control", "option", "shift", "command"]}] and reports success per name.
    func register(_ keys: [[String: Any]]) -> [String: Bool] {
        references.forEach { UnregisterEventHotKey($0) }
        references = []
        names = [:]
        codes = [:]
        held = [:]
        stopWatcherIfIdle()
        var result: [String: Bool] = [:]
        for (index, key) in keys.enumerated() {
            guard let name = key["name"] as? String, let code = key["code"] as? Int else { continue }
            var modifiers: UInt32 = 0
            for modifier in key["modifiers"] as? [String] ?? [] {
                switch modifier {
                case "control": modifiers |= UInt32(controlKey)
                case "option": modifiers |= UInt32(optionKey)
                case "shift": modifiers |= UInt32(shiftKey)
                case "command": modifiers |= UInt32(cmdKey)
                default: break
                }
            }
            var reference: EventHotKeyRef?
            let id = UInt32(index + 1)
            let status = RegisterEventHotKey(UInt32(code), modifiers, EventHotKeyID(signature: 0x44494354, id: id),
                                             GetApplicationEventTarget(), 0, &reference)
            if status == noErr, let reference {
                references.append(reference)
                names[id] = name
                codes[id] = CGKeyCode(code)
            }
            result[name] = status == noErr
        }
        return result
    }
}

// MARK: - Serve

let hotKeys = HotKeys()

func handle(_ request: [String: Any]) {
    let cmd = request["cmd"] as? String
    let id = request["id"]
    if cmd == "active-window", let numericId = id as? Int {
        pollLock.lock()
        let latest = latestActiveWindowRequestID
        pollLock.unlock()
        if numericId < latest {
            send(["id": numericId])
            return
        }
    }
    var reply: [String: Any]
    switch cmd {
    case "focus": reply = focus()
    case "paste": reply = ["ok": paste()]
    case "deliver": reply = deliver(request["text"] as? String ?? "")
    case "replace-last": reply = replaceLast(expected: request["expected"] as? String ?? "", replacement: request["text"] as? String ?? "")
    case "inputs": reply = inputs()
    case "screens": reply = ["screens": screens()]
    case "active-window": reply = activeWindowInfo()
    default: reply = ["error": "Unknown command."]
    }
    reply["id"] = id ?? NSNull()
    send(reply)
}

func serve() -> Never {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    hotKeys.onEvent = { name, pressed, at in
        // Dispatch to axQueue so Carbon returns immediately and never stalls key-up delivery,
        // while still guaranteeing down/up ordering and capturing focus before Electron acts.
        axQueue.async {
            var event: [String: Any] = ["event": "hotkey", "name": name, "state": pressed ? "down" : "up", "at": at]
            if ["dictate", "learnCorrection"].contains(name), pressed { event["focus"] = focus() }
            send(event)
        }
    }
    hotKeys.install()
    let workspace = NSWorkspace.shared
    if let front = workspace.frontmostApplication {
        let pid = front.processIdentifier
        axQueue.async { exposeTextFields(pid) }
    }
    // Warm existing Electron apps before the first shortcut, including apps behind this one.
    for (index, app) in workspace.runningApplications.filter(usesChromium).enumerated() {
        let pid = app.processIdentifier
        axQueue.asyncAfter(deadline: .now() + Double(index) * 0.05) { exposeTextFields(pid) }
    }
    workspace.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
        if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
            let pid = app.processIdentifier
            axQueue.async { exposeTextFields(pid) }
        }
    }
    workspace.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
        if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, usesChromium(app) {
            let pid = app.processIdentifier
            axQueue.asyncAfter(deadline: .now() + 1.0) { exposeTextFields(pid) }
        }
    }
    workspace.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { note in
        if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
            let pid = app.processIdentifier
            axQueue.async {
                exposedApplications.remove(pid)
                appIcons.removeValue(forKey: pid)
            }
        }
    }
    for notification in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification, NSWorkspace.sessionDidResignActiveNotification] {
        workspace.notificationCenter.addObserver(forName: notification, object: nil, queue: .main) { _ in
            hotKeys.releaseAll()
        }
    }
    Thread {
        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let cmd = request["cmd"] as? String
            if cmd == "hotkeys" {
                DispatchQueue.main.async {
                    let registered = hotKeys.register(request["keys"] as? [[String: Any]] ?? [])
                    send(["id": request["id"] ?? NSNull(), "registered": registered])
                }
            } else if cmd == "screens" {
                DispatchQueue.main.async {
                    send(["id": request["id"] ?? NSNull(), "screens": screens()])
                }
            } else {
                if cmd == "active-window", let numericId = request["id"] as? Int {
                    pollLock.lock()
                    latestActiveWindowRequestID = numericId
                    pollLock.unlock()
                }
                axQueue.async { handle(request) }
            }
        }
        exit(0) // Dictait quit or crashed: never linger.
    }.start()
    application.run()
    exit(0)
}

/// Diagnostics: press, hold and release a key from outside the listening process, like a keyboard.
func postTestKey(_ code: Int, _ modifiers: [String]) -> Int32 {
    guard AXIsProcessTrusted(), let source = CGEventSource(stateID: .hidSystemState) else { return 2 }
    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier {
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        case "command": flags.insert(.maskCommand)
        default: break
        }
    }
    let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    usleep(600_000)
    let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
    usleep(50_000)
    return 0
}

switch CommandLine.arguments.dropFirst().first {
case "serve": serve()
case "paste": exit(paste() ? 0 : 2)
case "focus": send(focus())
case "inputs": send(inputs())
case "screens":
    let data = (try? JSONSerialization.data(withJSONObject: screens())) ?? Data("[]".utf8)
    FileHandle.standardOutput.write(data)
case "post-key":
    let values = Array(CommandLine.arguments.dropFirst(2))
    exit(postTestKey(Int(values.first ?? "") ?? 0, Array(values.dropFirst())))
default:
    FileHandle.standardError.write(Data("Usage: dictait-helper serve|paste|focus|inputs|screens|post-key\n".utf8))
    exit(64)
}
