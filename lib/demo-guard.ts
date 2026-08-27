const DEMO_SLUG = "demo";
const DEMO_EMAIL = "demo@golden-core.app";

export function isDemoEvent(eventSlug: string): boolean {
    return eventSlug === DEMO_SLUG;
}

export function isDemoUser(email: string): boolean {
    return email === DEMO_EMAIL;
}

export function demoGuardResponse(): Response {
    return Response.json(
        { error: "Operation not available in demo mode" },
        { status: 403 }
    );
}
