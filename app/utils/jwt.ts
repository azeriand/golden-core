import jwt from 'jsonwebtoken'  

export default async function generateJWT(user: { id: number, email: string, is_admin: boolean }) {
    const token = jwt.sign(
        { userId: user.id, email: user.email, isAdmin: user.is_admin },
        process.env.JWT_SECRET,
        { expiresIn: '3d' }
    );

    return token;
}