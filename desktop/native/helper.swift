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

func string(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
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

/// The address of the page a window shows (a browser's tab, a web app's conversation), for
/// apps that keep their text boxes to themselves.
func windowPage(_ window: AXUIElement) -> String? {
    var queue = [window], seen = 0
    while !queue.isEmpty, seen < 300 {
        let node = queue.removeFirst()
        seen += 1
        let role = string(node, kAXRoleAttribute)
        if role == "AXWebArea" || role == "AXGroup", let url = attribute(node, kAXURLAttribute) as? URL { return url.absoluteString }
        queue += attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }
    return nil
}

/// What a text box calls itself, to recognise it when a web app rebuilds it.
func label(of element: AXUIElement) -> String {
    [kAXDescriptionAttribute, kAXPlaceholderValueAttribute as String, kAXTitleAttribute, "AXDOMIdentifier"]
        .map { string(element, $0) }.joined(separator: "|")
}

let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
let controlRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor",
    "AXList", "AXOutline", "AXTable", "AXBrowser", "AXRow", "AXCell", "AXImage", "AXScrollArea", "AXSplitGroup",
    "AXTabGroup", "AXToolbar", "AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem", "AXDockItem", "AXColorWell",
    "AXDisclosureTriangle", "AXLink", "AXStaticText", "AXLevelIndicator", "AXValueIndicator"
]

/// True for text fields, false for buttons, lists and other controls, nil when unsure.
func editable(_ element: AXUIElement) -> Bool? {
    let role = string(element, kAXRoleAttribute)
    if textRoles.contains(role) { return true }
    var names: CFArray?
    if AXUIElementCopyAttributeNames(element, &names) == .success, (names as? [String] ?? []).contains("AXEditableAncestor") { return true }
    return controlRoles.contains(role) ? false : nil
}

/// Where a dictation started: its text goes back here even if the user clicks somewhere else
/// while it is being transcribed.
struct Place {
    let pid: pid_t
    /// The text field, or nil when there was none and only the app and window are known.
    var element: AXUIElement?
    let window: AXUIElement?
    var range: CFRange?
    /// Text around the cursor, to find the spot again and to notice a different document.
    var before = ""
    var selected = ""
    var after = ""
    var page: String?
    var role = ""
    var label = ""
    /// Started on a button or list rather than anywhere text could go.
    var control = false
}

/// A place known only by its app, window and page.
func windowPlace(_ pid: pid_t, _ window: AXUIElement?, control: Bool = false) -> Place {
    Place(pid: pid, element: nil, window: window, page: window.flatMap(windowPage), control: control)
}

var anchor: Place?
/// Dictait's last insertion, for spoken follow-ups such as "hey, make that shorter".
var lastInsertion: Place?

func focusedWindow(_ pid: pid_t) -> AXUIElement? {
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.3)
    return elementAttribute(application, kAXFocusedWindowAttribute)
}

func windowOf(_ element: AXUIElement, _ pid: pid_t) -> AXUIElement? {
    elementAttribute(element, kAXWindowAttribute) ?? focusedWindow(pid)
}

func place(of element: AXUIElement, reading: Bool = true) -> Place? {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success, pid > 0 else { return nil }
    var found = Place(pid: pid, element: element, window: windowOf(element, pid), range: selectedRange(element))
    guard reading else { return found }
    found.page = page(of: element)
    found.role = string(element, kAXRoleAttribute)
    found.label = label(of: element)
    if let range = found.range {
        let start = max(0, range.location - 600)
        found.before = text(element, in: CFRange(location: start, length: range.location - start)) ?? ""
        found.selected = text(element, in: range) ?? ""
        let end = range.location + range.length
        if let count = characterCount(element), count > end {
            found.after = text(element, in: CFRange(location: end, length: min(200, count - end))) ?? ""
        }
    }
    return found
}

/// Where the user is now: the focused element, or at least the front app and its window.
func currentPlace() -> Place? {
    if let element = focusedElement(), let found = place(of: element, reading: false) { return found }
    guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
    return Place(pid: front.processIdentifier, element: nil, window: focusedWindow(front.processIdentifier))
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
    guard let element = focused, var found = place(of: element) else {
        // No field: remember the app and window, so the words go nowhere else.
        if anchoring, let front { anchor = windowPlace(front.processIdentifier, focusedWindow(front.processIdentifier)) }
        if let front, let window = focusedWindow(front.processIdentifier) {
            result["window"] = String(string(window, kAXTitleAttribute).prefix(200))
        }
        return result
    }
    result["role"] = found.role
    // The window title tells a browser's Gmail from its ChatGPT; it is never saved.
    if let window = found.window { result["window"] = String(string(window, kAXTitleAttribute).prefix(200)) }
    let kind = editable(element)
    if kind != true || found.role == "AXWebArea" {
        // A button, a list, or a whole web page: no text cursor to come back to.
        if let kind { result["editable"] = kind }
        if anchoring { anchor = windowPlace(found.pid, found.window, control: kind == false) }
        return result
    }
    result["editable"] = true
    if string(element, kAXSubroleAttribute) == "AXSecureTextField" {
        result["secure"] = true
        found.before = ""; found.selected = ""; found.after = ""
        if anchoring { anchor = found }
        return result
    }
    result["selected"] = String(string(element, kAXSelectedTextAttribute).prefix(8000))
    result["before"] = found.before
    if anchoring { anchor = found }
    return result
}

// MARK: - Finding the place again

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

/// Waits up to `seconds` for a condition, checking every 20 ms.
func wait(_ seconds: Double, until condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() {
        if Date() >= deadline { return false }
        usleep(20_000)
    }
    return true
}

/// Whether an element is the place's text box: the same one, or one a web app rebuilt in its
/// place, on the same page.
func matches(_ element: AXUIElement, _ target: Place) -> Bool {
    guard let field = target.element else { return false }
    if CFEqual(element, field) { return target.page == nil || page(of: element) == target.page }
    guard target.page != nil, !target.label.isEmpty, string(element, kAXRoleAttribute) == target.role,
          label(of: element) == target.label else { return false }
    return page(of: element) == target.page
}

enum Spot {
    /// Still the same text; paste at this range (nil: wherever its cursor is).
    case same(CFRange?)
    /// The box now holds another document or conversation.
    case different
}

/// Finds where the cursor was by the text around it, which also shows whether an app that
/// reuses one text view (Notes, chat apps) now shows something else in it.
func spot(of target: Place, in element: AXUIElement) -> Spot {
    guard let range = target.range else { return .same(nil) }
    let before = String(target.before.suffix(200)), after = target.after, selected = target.selected
    let length = (selected as NSString).length
    if before.isEmpty && after.isEmpty { return .same(range) }
    let lead = (before as NSString).length
    if !before.isEmpty, text(element, in: CFRange(location: range.location - lead, length: lead)) == before,
       length == 0 || text(element, in: CFRange(location: range.location, length: length)) == selected {
        return .same(range)
    }
    guard let all = wholeText(element) else {
        // Unreadable text: trust the box, and paste at its own cursor.
        return text(element, in: CFRange(location: 0, length: 1)) == nil ? .same(nil) : .different
    }
    // Text was added or removed earlier on: look for the words around the cursor, nearest first.
    var spots: [Int] = []
    for (pattern, offset) in [(before + selected, lead), (selected + after, 0)] where pattern != selected {
        var search = NSRange(location: 0, length: all.length)
        while true {
            let found = all.range(of: pattern, options: [], range: search)
            if found.location == NSNotFound { break }
            spots.append(found.location + offset)
            search = NSRange(location: found.location + 1, length: all.length - found.location - 1)
        }
    }
    guard let best = spots.min(by: { abs($0 - range.location) < abs($1 - range.location) }) else { return .different }
    return .same(CFRange(location: best, length: length))
}

/// Whether the user is at the place right now, and where in it to paste.
func here(_ target: Place) -> (element: AXUIElement?, range: CFRange?)? {
    let element = focusedElement()
    var pid: pid_t = 0
    if let element { AXUIElementGetPid(element, &pid) } else { pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0 }
    guard pid == target.pid else { return nil }
    guard target.element != nil else {
        // Only the window was known: any spot in it will do, while it shows the same page.
        let window = element.flatMap { windowOf($0, target.pid) } ?? focusedWindow(target.pid)
        if let window, let wanted = target.window, !CFEqual(window, wanted) { return nil }
        if let page = target.page, window.flatMap(windowPage) != page { return nil }
        return (element, nil)
    }
    guard let element, matches(element, target), case .same(let range) = spot(of: target, in: element) else { return nil }
    return (element, range)
}

/// Whether the place's window could come back: not closed, minimised or in a hidden app.
/// (Windows on another Space go unlisted, so being brought back is what really proves it.)
func showing(_ target: Place) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: target.pid), !app.isTerminated, !app.isHidden else { return false }
    guard let window = target.window else { return true }
    return !isGone(window) && (attribute(window, kAXMinimizedAttribute) as? Bool) != true
}

/// The place's text box as it is now: the same one, or a rebuilt one on the same page.
func locate(_ target: Place) -> AXUIElement? {
    guard let field = target.element else { return nil }
    if !isGone(field) { return matches(field, target) ? field : nil }
    guard target.page != nil, !target.label.isEmpty, let window = target.window, !isGone(window) else { return nil }
    var queue = [window], seen = 0
    while !queue.isEmpty, seen < 2500 {
        let node = queue.removeFirst()
        seen += 1
        if string(node, kAXRoleAttribute) == target.role, matches(node, target) { return node }
        queue += attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }
    return nil
}

// MARK: - Delivery to where the dictation started

func frame(_ element: AXUIElement) -> String {
    "\(String(describing: attribute(element, kAXPositionAttribute))) \(String(describing: attribute(element, kAXSizeAttribute)))"
}

func isFocused(_ element: AXUIElement, _ target: Place) -> Bool {
    guard let current = focusedElement() else { return false }
    if CFEqual(current, element) || matches(current, target) { return true }
    // Some apps hand out a new reference for the same box each time: same kind, same spot.
    var pid: pid_t = 0
    AXUIElementGetPid(current, &pid)
    return pid == target.pid && string(current, kAXRoleAttribute) == target.role && frame(current) == frame(element)
}

/// Makes an app frontmost, through Accessibility first and AppKit if that does not take.
func bringToFront(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return false }
    if isFrontmost(pid) { return true }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.5)
    AXUIElementSetAttributeValue(application, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if wait(0.3, until: { isFrontmost(pid) }) { return true }
    app.activate(options: [])
    return wait(0.6, until: { isFrontmost(pid) })
}

/// Brings the place's app and window forward and focuses its text box. True only once the box
/// really has focus: an app may accept the request and leave focus elsewhere.
func bringBack(_ target: Place, _ element: AXUIElement) -> Bool {
    guard bringToFront(target.pid) else { return false }
    if let window = target.window {
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    if isFocused(element, target) { return true }
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    return wait(0.6, until: { isFocused(element, target) })
}

/// Takes the user back to where they were before Dictait went to paste.
func returnTo(_ away: Place?, from target: Place) {
    guard let away else { return }
    if away.pid != target.pid { _ = bringToFront(away.pid) }
    if let window = away.window { AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
    if let element = away.element { AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
}

func setClipboard(_ text: String) {
    guard !text.isEmpty else { return }
    let board = NSPasteboard.general
    if board.string(forType: .string) == text { return }
    board.clearContents()
    board.setString(text, forType: .string)
}

/// ⌘V into the focused element at `range` (or its own cursor), then notes where the words
/// landed for follow-ups. With `keepCursor`, a cursor the user had moved elsewhere in the same
/// box goes back there afterwards.
func paste(_ text: String, into element: AXUIElement?, of target: Place, at range: CFRange?, keepCursor: Bool = true) -> Bool {
    let user = element.flatMap(selectedRange)
    if let element, let range, user.map({ $0.location != range.location || $0.length != range.length }) ?? true {
        setSelectedRange(element, range)
        usleep(30_000)
    }
    let start = element.flatMap(selectedRange)
    setClipboard(text)
    guard paste() else { return false }
    lastInsertion = nil
    guard let element, let start else {
        usleep(150_000) // Let ⌘V land before anything moves.
        return true
    }
    // The app handles ⌘V on its own time; the cursor moving shows it has.
    var end: CFRange?
    _ = wait(0.6) {
        guard let now = selectedRange(element), now.location != start.location || now.length != start.length else { return false }
        end = now
        return true
    }
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

/// Pastes where the dictation started. If the user has moved to another box, window or app,
/// Dictait goes back, checks it really is there, pastes and returns them. If that place is not
/// on screen (another conversation, a closed Raycast), it waits until the user goes back.
func deliver(_ text: String) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["outcome": "untrusted"] }
    guard let target = anchor else { return ["outcome": "no-anchor"] }
    anchor = nil
    if let (element, range) = here(target) {
        if target.element == nil, let element, editable(element) == false { return ["outcome": "no-target"] }
        return ["outcome": paste(text, into: element, of: target, at: range) ? "pasted" : "failed"]
    }
    // Only the window was known: go back to it, if it still shows the same page.
    guard target.element != nil else { return windowDelivery(target, text) }
    guard showing(target), let element = locate(target), case .same(let range) = spot(of: target, in: element) else {
        waitForReturn(target, text)
        return ["outcome": "waiting"]
    }
    let away = currentPlace()
    guard bringBack(target, element) else {
        returnTo(away, from: target)
        waitForReturn(target, text)
        return ["outcome": "waiting"]
    }
    guard paste(text, into: element, of: target, at: range, keepCursor: false) else { return ["outcome": "failed"] }
    returnTo(away, from: target)
    return ["outcome": "pasted", "returned": away != nil]
}

/// Delivery to a place known only by its window, for apps that hide their text boxes: the
/// window comes back with its page's own cursor, as long as it still shows the same page.
func windowDelivery(_ target: Place, _ text: String) -> [String: Any] {
    guard !target.control else { return ["outcome": "moved"] }
    guard let window = target.window, !isGone(window) else { return ["outcome": "gone"] }
    guard showing(target), target.page == nil || windowPage(window) == target.page else {
        waitForReturn(target, text)
        return ["outcome": "waiting"]
    }
    let away = currentPlace()
    guard bringToFront(target.pid) else { return ["outcome": "gone"] }
    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    guard wait(0.6, until: { focusedWindow(target.pid).map { CFEqual($0, window) } ?? false }), let (element, _) = here(target) else {
        returnTo(away, from: target)
        waitForReturn(target, text)
        return ["outcome": "waiting"]
    }
    usleep(150_000) // The page puts its own cursor back.
    if let element, editable(element) == false {
        returnTo(away, from: target)
        return ["outcome": "no-target"]
    }
    guard paste(text, into: element, of: target, at: nil, keepCursor: false) else { return ["outcome": "failed"] }
    returnTo(away, from: target)
    return ["outcome": "pasted", "returned": away != nil]
}

/// Dictations whose place was not on screen, each pasted when the user comes back to it.
var waiting: [(target: Place, text: String, until: Date)] = []
var waitTimer: Timer?

func waitForReturn(_ target: Place, _ text: String) {
    waiting = Array((waiting + [(target, text, Date().addingTimeInterval(10 * 60))]).suffix(5))
    if waitTimer == nil {
        waitTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in checkReturn() }
    }
}

func checkReturn() {
    waiting.removeAll { Date() >= $0.until }
    if waiting.isEmpty { waitTimer?.invalidate(); waitTimer = nil; return }
    guard AXIsProcessTrusted() else { return }
    for (index, item) in waiting.enumerated() {
        guard let (element, range) = here(item.target), item.target.element != nil || element.flatMap(editable) != false else { continue }
        waiting.remove(at: index)
        // Already there: the user pasted it themselves.
        if let element, let all = wholeText(element), squashed(item.text).count > 3,
           squashed(all as String).contains(squashed(item.text)) { return }
        let pasted = paste(item.text, into: element, of: item.target, at: range)
        send(["event": "delivered", "outcome": pasted ? "pasted" : "failed", "text": item.text])
        return
    }
}

func squashed(_ value: String) -> String {
    value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// Replaces Dictait's last insertion with new text, only if it still reads as pasted.
func replaceLast(expected: String, replacement: String) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["outcome": "untrusted"] }
    guard let last = lastInsertion, let range = last.range, let element = locate(last) else { return ["outcome": "gone"] }
    guard squashed(text(element, in: range) ?? "") == squashed(expected) else { return ["outcome": "changed"] }
    let atPlace = focusedElement().map { CFEqual($0, element) || matches($0, last) } ?? false
    let away = atPlace ? nil : currentPlace()
    if away != nil {
        guard showing(last), bringBack(last, element) else {
            returnTo(away, from: last)
            return ["outcome": "gone"]
        }
    }
    guard paste(replacement, into: element, of: last, at: range, keepCursor: away == nil) else { return ["outcome": "failed"] }
    returnTo(away, from: last)
    return ["outcome": "replaced", "returned": away != nil]
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
    case "deliver": reply = deliver(request["text"] as? String ?? "")
    case "replace-last": reply = replaceLast(expected: request["expected"] as? String ?? "", replacement: request["text"] as? String ?? "")
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
