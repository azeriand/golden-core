//Log out endpoint

import { cookies } from "next/headers";

export async function POST() {
    const cookieStore = await cookies();

    cookieStore.delete("auth_token");

    return Response.json({
        message: "Logged out successfully"
    });
}