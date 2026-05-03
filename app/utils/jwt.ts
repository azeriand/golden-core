import jwt from 'jsonwebtoken'  

export default async function generateJWT(user: { user_id: number, user_email: string, is_admin: boolean }) {
    const token = jwt.sign(
        { userId: user.user_id, email: user.user_email, isAdmin: user.is_admin },
        process.env.JWT_SECRET,
        { expiresIn: '3d' }
    );

    return token;
}