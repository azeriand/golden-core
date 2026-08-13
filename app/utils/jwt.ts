import jwt from 'jsonwebtoken'  

export default async function generateJWT(user: { user_id: number, user_email: string, is_admin: boolean }): Promise<string> {

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
        throw new Error("JWT_SECRET is not configured");
    }

    const token = jwt.sign(
        {
            userId: user.user_id,
            email: user.user_email,
            isAdmin: user.is_admin
        },
        jwtSecret,
        { expiresIn: '3d' }
    );

    return token;
}