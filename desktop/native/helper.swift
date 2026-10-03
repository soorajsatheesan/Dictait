// Dictait's native companion, for what Electron cannot do itself:
// global shortcuts with press *and* release (hold-to-talk), reading the focused text field
// (context, selection), sending ⌘V, and describing microphones and the camera notch.
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

/// Describes the focused element. "editable" is true, false, or null when unsure; only a
/// confident false makes Dictait copy instead of paste. Text near the cursor and the current
/// selection are read for context and voice edits, never from password fields.
func focus() -> [String: Any] {
    let front = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = [
        "app": front?.bundleIdentifier ?? "", "appName": front?.localizedName ?? "",
        "editable": NSNull(), "before": "", "selected": ""
    ]
    guard AXIsProcessTrusted() else { return result }
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return result }
    let element = value as! AXUIElement
    AXUIElementSetMessagingTimeout(element, 0.3)
    func string(_ name: String) -> String {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &raw) == .success else { return "" }
        return raw as? String ?? ""
    }
    let role = string(kAXRoleAttribute), subrole = string(kAXSubroleAttribute)
    result["role"] = role
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
        return result
    }
    if subrole == "AXSecureTextField" { result["secure"] = true; return result }
    result["selected"] = String(string(kAXSelectedTextAttribute).prefix(8000))
    var rangeValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeValue) == .success,
       let rangeValue, CFGetTypeID(rangeValue) == AXValueGetTypeID() {
        var selection = CFRange()
        AXValueGetValue(rangeValue as! AXValue, .cfRange, &selection)
        let start = max(0, selection.location - 600)
        var wanted = CFRange(location: start, length: selection.location - start)
        if wanted.length > 0, let parameter = AXValueCreate(.cfRange, &wanted) {
            var text: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, parameter, &text) == .success,
               let text = text as? String {
                result["before"] = text
            } else {
                // Some editors only expose the whole value; slice it when it is a reasonable size.
                let whole = string(kAXValueAttribute) as NSString
                if whole.length < 500_000, start + wanted.length <= whole.length {
                    result["before"] = whole.substring(with: NSRange(location: start, length: wanted.length))
                }
            }
        }
    }
    return result
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
    case "focus": reply = focus()
    case "paste": reply = ["ok": paste()]
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
