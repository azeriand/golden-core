"use client"
import { Card } from "azeriand-library";
import { useState } from "react";
import SignUp from "./sign-up";
import LogIn from "./log-in";


export default function AuthPopup() {

    const [mode, setMode] = useState<"signup" | "login">("signup");


    return (
        <div className="fixed inset-0 z-70 flex items-center justify-center bg-white/20 p-4" style={{ backdropFilter: "blur(5px)" }}>
            <Card appearance="mate" color="white" intensity={200} className="flex flex-col gap-y-4 items-center" style={{ boxShadow: "0 20px 40px rgba(0, 0, 0, 0.35)" }}>
                    
                <h1 className='text-gray-600 text-lg'>Golden·Core</h1>

                {mode === "signup" ? (
                    <SignUp onLogin={() => setMode("login")} />
                ) : (
                    <LogIn onSignup={() => setMode("signup")} />
                )}

            </Card>
        </div>
    )
}