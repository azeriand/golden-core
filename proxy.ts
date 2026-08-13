import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
    console.log("Proxy ejecutado");
    const token = request.cookies.get("auth_token")?.value;

    return NextResponse.next();
}

export const config = {
    matcher: ["/"],
};