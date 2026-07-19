import Foundation

struct ArchieStarter: Identifiable, Hashable, Sendable {
    enum Audience: String, CaseIterable, Identifiable, Sendable {
        case creator = "Creators"
        case seller = "Sellers"
        case organizer = "Organizers"
        case student = "Students"

        var id: String { rawValue }
    }

    let id: String
    let title: String
    let subtitle: String
    let symbol: String
    let audience: Audience
    let creationBrief: String

    static let catalog: [ArchieStarter] = [
        ArchieStarter(
            id: "creator-command-center",
            title: "Creator Command Center",
            subtitle: "Turn loose ideas into a weekly posting system.",
            symbol: "play.rectangle.on.rectangle.fill",
            audience: .creator,
            creationBrief: """
            Build a private, phone-first Creator Command Center for an independent creator. It should capture raw post ideas in seconds, turn each idea into a simple draft card, organize a realistic weekly queue, track whether a post is drafted, filmed, edited, posted, or repurposed, and record lightweight performance notes without becoming an analytics dashboard. Make the core interaction one-thumb friendly, fast, offline-first, and visually motivating. Include a Today view, an Idea Inbox, a simple content pipeline, and a reusable post-mortem prompt. Do not require social platform credentials for the first useful version.
            """
        ),
        ArchieStarter(
            id: "deal-drawer",
            title: "Deal Drawer",
            subtitle: "Track resale inventory, buyers, and profit without spreadsheets.",
            symbol: "shippingbox.fill",
            audience: .seller,
            creationBrief: """
            Build a local-first resale inventory app for someone selling clothes, electronics, or collectibles from their phone. Let the user photograph or name an item, record cost, target price, listing locations, interested buyers, offers, sale price, fees, and pickup or shipping status. Show the next action for every item and a simple realized-profit total. Optimize for ten-second updates while standing in a store, car, or meetup. Avoid accounting complexity and avoid claiming marketplace integrations that are not connected.
            """
        ),
        ArchieStarter(
            id: "event-pocket",
            title: "Event Pocket",
            subtitle: "Run a meetup, shoot, pop-up, or party from one live checklist.",
            symbol: "person.3.sequence.fill",
            audience: .organizer,
            creationBrief: """
            Build a phone-first event runbook for a small organizer managing a meetup, content shoot, pop-up, volunteer day, or party. It should combine a countdown, people and responsibilities, a compact supply list, arrival confirmations, a live issue log, and an after-event wrap-up. The home screen should always show what must happen next. Make it useful offline and easy to share or export later, but do not claim messaging, calendar, or ticketing integrations unless they are actually connected.
            """
        ),
        ArchieStarter(
            id: "study-sprint",
            title: "Study Sprint",
            subtitle: "Convert assignments into focused sessions and proof of progress.",
            symbol: "timer.square.fill",
            audience: .student,
            creationBrief: """
            Build a calm phone-first study app for a student who struggles with starting and tracking multi-step assignments. The user should paste an assignment, break it into small finishable sprints, choose one sprint for Now, run a simple focus timer, attach a note or photo as proof of progress, and see what remains without guilt language. Include a weekly recovery view for overdue work. Keep it offline-first and avoid pretending to connect to a school portal until credentials and an integration are available.
            """
        ),
        ArchieStarter(
            id: "client-pocket",
            title: "Client Pocket",
            subtitle: "Keep small freelance jobs moving without a full CRM.",
            symbol: "person.crop.rectangle.stack.fill",
            audience: .creator,
            creationBrief: """
            Build a minimal local-first client tracker for a freelancer, photographer, editor, designer, or social media manager. Each job needs a client, promised outcome, price, deposit state, next action, deadline, files or notes, revision count, and completion status. The main screen should show only the jobs that need attention today. Add reusable intake and delivery checklists. Avoid enterprise CRM language and do not claim email, payment, or cloud-storage integrations unless connected.
            """
        ),
        ArchieStarter(
            id: "shift-handoff",
            title: "Shift Handoff",
            subtitle: "Leave the next person the exact state of the work.",
            symbol: "arrow.left.arrow.right.square.fill",
            audience: .organizer,
            creationBrief: """
            Build a fast shift-handoff app for a small retail, food, event, or operations team. Capture what was completed, what is blocked, inventory or equipment concerns, customer follow-ups, and the first three actions for the next shift. Make entries timestamped and easy to scan. The first version should work locally on one phone and support honest export later; do not imply multi-user sync until a real backend exists.
            """
        )
    ]
}
