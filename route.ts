import { NextRequest, NextResponse } from "next/server";
import { loginAdmin, COOKIE_NAME } from "@/lib/admin-auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, otp } = body;
    if (!email || !password || !otp) {
      return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
    }

    const result = await loginAdmin(String(email), String(password), String(otp));
    if (!result.success || !result.token) {
      return NextResponse.json(
        { error: result.error || "Invalid credentials" },
        { status: 401 }
      );
    }

    const res = NextResponse.json({
      success: true,
      role: result.role,
    });

    res.cookies.set(COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/admin",
      maxAge: 60 * 60 * 8,
    });

    return res;
  } catch (err) {
    console.error("[admin/login]", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
