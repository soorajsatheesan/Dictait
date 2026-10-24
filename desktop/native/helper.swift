// Dictait's native companion, for what Electron cannot do itself:
// global shortcuts with press *and* release (hold-to-talk), reading the focused text field
// (context, selection), sending ⌘V back to where a dictation started, and describing
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

// MARK: - Output

let outputLock = NSLock()
func send(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    outputLock.unlock()
}

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

// MARK: - Paste

func postKey(_ code: CGKeyCode, flags: CGEventFlags) -> Bool {
    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return true
}

func paste() -> Bool {
    guard AXIsProcessTrusted() else { return false }
    // The normal keyboard path reaches menus, browser editors and native text controls alike.
    let posted = postKey(9, flags: .maskCommand)
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

func focusedElement() -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    var element = elementAttribute(system, kAXFocusedUIElementAttribute)
    if element == nil, let front = NSWorkspace.shared.frontmostApplication {
        // Electron apps can refuse the system-wide question yet answer when asked directly.
        let application = AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.3)
        element = elementAttribute(application, kAXFocusedUIElementAttribute)
    }
    if let element { AXUIElementSetMessagingTimeout(element, 0.3) }
    return element
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

/// The element's text in a range; some editors only expose their whole value, which is sliced
/// when it is a reasonable size.
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
    guard let whole = attribute(element, kAXValueAttribute) as? String else { return nil }
    let all = whole as NSString
    guard all.length < 500_000, range.location + range.length <= all.length else { return nil }
    return all.substring(with: NSRange(location: range.location, length: range.length))
}

/// Where a dictation started: its text goes back here even if the user clicks somewhere else
/// while it is being transcribed.
struct Place {
    let pid: pid_t
    /// The text field, when the app describes it; some only reveal their app and window.
    let element: AXUIElement?
    let window: AXUIElement?
    var range: CFRange?
    /// Text just before the range, to tell whether the cursor's spot still means the same place.
    var before = ""
}

var anchor: Place?
/// Dictait's last insertion, for spoken follow-ups such as "hey, make that shorter".
var lastInsertion: Place?

func focusedWindow(_ pid: pid_t) -> AXUIElement? {
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.3)
    return elementAttribute(application, kAXFocusedWindowAttribute)
}

func place(of element: AXUIElement) -> Place? {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success, pid > 0 else { return nil }
    let window = elementAttribute(element, kAXWindowAttribute) ?? focusedWindow(pid)
    return Place(pid: pid, element: element, window: window, range: selectedRange(element))
}

/// Where the user is now: the focused text field, or at least the front app and its window.
func currentPlace() -> Place? {
    if let element = focusedElement(), let found = place(of: element) { return found }
    guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
    return Place(pid: front.processIdentifier, element: nil, window: focusedWindow(front.processIdentifier))
}

/// Whether two places are the same field, or failing that the same window of the same app.
func same(_ one: Place, _ other: Place) -> Bool {
    guard one.pid == other.pid else { return false }
    if let a = one.element, let b = other.element { return CFEqual(a, b) }
    if let a = one.window, let b = other.window { return CFEqual(a, b) }
    return true
}

/// Electron apps (Codex, Slack, T3 Code…) describe their text fields only to assistive apps
/// that ask. Dictait asks as each app comes to the front, so they are ready for ⌃Space.
func exposeTextFields(_ pid: pid_t) {
    guard AXIsProcessTrusted(), pid != getpid() else { return }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.3)
    AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

/// Describes the focused element. "editable" is true, false, or null when unsure; only a
/// confident false makes Dictait copy instead of paste. Text near the cursor and the current
/// selection are read for context and voice edits, never from password fields. With
/// `anchoring`, the element is remembered as where the coming dictation belongs.
func focus(anchoring: Bool = false) -> [String: Any] {
    let front = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = [
        "app": front?.bundleIdentifier ?? "", "appName": front?.localizedName ?? "",
        "editable": NSNull(), "before": "", "selected": "", "window": ""
    ]
    if anchoring { anchor = nil }
    guard AXIsProcessTrusted() else { return result }
    var focused = focusedElement()
    if focused == nil, let front {
        // An Electron app that was already in front when Dictait started: ask, and give it a moment.
        exposeTextFields(front.processIdentifier)
        _ = wait(0.4) { focused = focusedElement(); return focused != nil }
    }
    guard let element = focused else {
        // Still no field: remember the app and window, so the words at least go back there.
        if anchoring, let front { anchor = Place(pid: front.processIdentifier, element: nil, window: focusedWindow(front.processIdentifier)) }
        if let front, let window = focusedWindow(front.processIdentifier) {
            result["window"] = String((attribute(window, kAXTitleAttribute) as? String ?? "").prefix(200))
        }
        return result
    }
    func string(_ name: String) -> String { attribute(element, name) as? String ?? "" }
    let role = string(kAXRoleAttribute), subrole = string(kAXSubroleAttribute)
    result["role"] = role
    var found = place(of: element)
    // The window title tells a browser's Gmail from its ChatGPT; it is never saved.
    if let window = found?.window { result["window"] = String((attribute(window, kAXTitleAttribute) as? String ?? "").prefix(200)) }
    let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    let controls: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor",
        "AXList", "AXOutline", "AXTable", "AXBrowser", "AXRow", "AXCell", "AXImage", "AXScrollArea", "AXSplitGroup",
        "AXTabGroup", "AXToolbar", "AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem", "AXDockItem", "AXColorWell",
        "AXDisclosureTriangle", "AXLink", "AXStaticText", "AXLevelIndicator", "AXValueIndicator"
    ]
    var names: CFArray?
    let attributes = AXUIElementCopyAttributeNames(element, &names) == .success ? (names as? [String] ?? []) : []
    if textRoles.contains(role) || attributes.contains("AXEditableAncestor") {
        result["editable"] = true
    } else if controls.contains(role) {
        result["editable"] = false
        return result
    } else {
        // Not a known text field (often a whole web page): putting focus back on it could pull
        // the cursor out of the page's own field, so remember only the app and window.
        if anchoring, let found { anchor = Place(pid: found.pid, element: nil, window: found.window) }
        return result
    }
    if subrole == "AXSecureTextField" {
        result["secure"] = true
        if anchoring { anchor = found }
        return result
    }
    result["selected"] = String(string(kAXSelectedTextAttribute).prefix(8000))
    if let selection = found?.range {
        let start = max(0, selection.location - 600)
        result["before"] = text(element, in: CFRange(location: start, length: selection.location - start)) ?? ""
    }
    found?.before = result["before"] as? String ?? ""
    if anchoring { anchor = found }
    return result
}

// MARK: - Delivery to where the dictation started

func isFrontmost(_ pid: pid_t) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.3)
    return (attribute(app, kAXFrontmostAttribute) as? Bool) == true
}

func isGone(_ element: AXUIElement?) -> Bool {
    guard let element else { return false }
    var role: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .invalidUIElement
}

func isFocused(_ element: AXUIElement) -> Bool {
    guard let current = focusedElement() else { return false }
    return CFEqual(current, element)
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

/// Makes an app frontmost, through Accessibility first and AppKit if that does not take.
func bringToFront(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return false }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.5)
    AXUIElementSetAttributeValue(application, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if wait(0.3, until: { isFrontmost(pid) }) { return true }
    app.activate(options: [])
    return wait(0.6, until: { isFrontmost(pid) })
}

/// Brings a place's app and window to the front and focuses its element. False when the
/// element or window is gone, or focus cannot be put back on it.
func bringBack(_ target: Place) -> Bool {
    if isGone(target.element) || (target.element == nil && isGone(target.window)) { return false }
    guard bringToFront(target.pid) else { return false }
    if let window = target.window {
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    guard let element = target.element else {
        // The page keeps its own cursor; it comes back with the window.
        usleep(200_000)
        return true
    }
    let focused = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    if wait(0.4, until: { isFocused(element) }) { return true }
    // Web views can report the same field under a new reference; trust a focus that was accepted.
    return focused
}

/// Puts the cursor back where it was, if the text before it is still the same.
func restoreCursor(_ target: Place) {
    guard let element = target.element, let range = target.range else { return }
    if let now = selectedRange(element), now.location == range.location, now.length == range.length { return }
    let length = (target.before as NSString).length
    guard length > 0 || range.location == 0, text(element, in: CFRange(location: range.location - length, length: length)) == target.before else { return }
    setSelectedRange(element, range)
    usleep(30_000)
}

/// ⌘V into a place that has focus, then notes where the words landed for follow-ups.
func paste(into target: Place, length: Int) -> Bool {
    let start = target.element.flatMap(selectedRange)
    guard paste() else { return false }
    lastInsertion = nil
    guard let element = target.element, let start else { return true }
    // The app handles ⌘V on its own time; the cursor moving shows it has.
    var end: CFRange?
    _ = wait(0.4) {
        guard let now = selectedRange(element), now.location != start.location || now.length != start.length else { return false }
        end = now
        return true
    }
    let inserted = end.map { $0.location - start.location } ?? length
    if inserted > 0 {
        lastInsertion = Place(pid: target.pid, element: target.element, window: target.window,
                              range: CFRange(location: start.location, length: inserted))
    }
    return true
}

/// Pastes the clipboard where the dictation started. If the user has moved on, Dictait goes
/// back there, pastes, and returns them to where they are now.
func deliver(length: Int) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["outcome": "untrusted"] }
    guard let target = anchor else { return ["outcome": "no-anchor"] }
    anchor = nil
    return pasteBack(target, length: length)
}

func squashed(_ value: String) -> String {
    value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// Replaces Dictait's last insertion with the clipboard, only if it still reads as pasted.
func replaceLast(expected: String, length: Int) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["outcome": "untrusted"] }
    guard let last = lastInsertion, let element = last.element, let range = last.range, !isGone(element) else { return ["outcome": "gone"] }
    guard let current = text(element, in: range), squashed(current) == squashed(expected) else { return ["outcome": "changed"] }
    return pasteBack(last, selecting: range, length: length)
}

/// Pastes into a place, going back to it first if focus has moved, then returning. With
/// `selecting`, that range is replaced; otherwise the cursor goes back where it was.
func pasteBack(_ target: Place, selecting: CFRange? = nil, length: Int) -> [String: Any] {
    let away = currentPlace().flatMap { same($0, target) ? nil : $0 }
    if away != nil, !bringBack(target) { return ["outcome": "gone"] }
    if let selecting {
        guard let element = target.element, setSelectedRange(element, selecting) else { return ["outcome": "changed"] }
        usleep(30_000)
    } else {
        restoreCursor(target)
    }
    guard paste(into: target, length: length) else { return ["outcome": "failed"] }
    if let away {
        if lastInsertion == nil { usleep(250_000) } // Let ⌘V land before focus moves on.
        if away.pid != target.pid { _ = bringToFront(away.pid) }
        if let window = away.window { AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
        if let element = away.element { AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
    }
    return ["outcome": selecting == nil ? "pasted" : "replaced", "returned": away != nil]
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
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
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
    private var held: Set<UInt32> = []
    private var handler: EventHandlerRef?
    var onEvent: (String, Bool) -> Void = { _, _ in }

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
            keys.handle(identifier.id, pressed: GetEventKind(event) == UInt32(kEventHotKeyPressed))
            return noErr
        }
        InstallEventHandler(GetApplicationEventTarget(), callback, 2, &types, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    private func handle(_ id: UInt32, pressed: Bool) {
        guard let name = names[id] else { return }
        // Key auto-repeat sends repeated presses; report one down and one up.
        if pressed {
            guard !held.contains(id) else { return }
            held.insert(id)
        } else {
            held.remove(id)
        }
        onEvent(name, pressed)
    }

    /// Registers [{name, code, modifiers: ["control", "option", "shift", "command"]}] and reports success per name.
    func register(_ keys: [[String: Any]]) -> [String: Bool] {
        references.forEach { UnregisterEventHotKey($0) }
        references = []
        names = [:]
        held = []
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
            }
            result[name] = status == noErr
        }
        return result
    }
}

// MARK: - Serve

let hotKeys = HotKeys()

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    var reply: [String: Any]
    switch request["cmd"] as? String {
    case "hotkeys": reply = ["registered": hotKeys.register(request["keys"] as? [[String: Any]] ?? [])]
    case "focus": reply = focus(anchoring: request["anchor"] as? Bool ?? false)
    case "forget": anchor = nil; reply = ["ok": true]
    case "paste": reply = ["ok": paste()]
    case "deliver": reply = deliver(length: request["length"] as? Int ?? 0)
    case "replace-last": reply = replaceLast(expected: request["expected"] as? String ?? "", length: request["length"] as? Int ?? 0)
    case "inputs": reply = inputs()
    case "screens": reply = ["screens": screens()]
    default: reply = ["error": "Unknown command."]
    }
    reply["id"] = request["id"] ?? NSNull()
    send(reply)
}

func serve() -> Never {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    hotKeys.onEvent = { name, pressed in send(["event": "hotkey", "name": name, "state": pressed ? "down" : "up"]) }
    hotKeys.install()
    let workspace = NSWorkspace.shared
    if let front = workspace.frontmostApplication { exposeTextFields(front.processIdentifier) }
    workspace.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
        if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { exposeTextFields(app.processIdentifier) }
    }
    Thread {
        while let line = readLine() {
            DispatchQueue.main.async { handle(line) }
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
