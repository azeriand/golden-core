"use client"
import { Button, Card, Input } from 'azeriand-library'
import useSignUpStore from '../src/stores/sign-up.store'

    interface Props {
        onLogin: () => void;
    }

export default function SignUp({ onLogin }: Props) {
    const { email, password, username, confirmPassword, loading, setEmail, setPassword, setUsername, setConfirmPassword, register} = useSignUpStore();

    return (
        <>
            <p className='text-sm text-gray-600'>Crear cuenta</p>
            <Input appearance='mate' color='purple' intensity={500} placeholder='Email' type='email' value={email} onChange={setEmail as any} className='text-gray-600' />
            <Input appearance='mate' color='purple' intensity={500} placeholder='Nombre de usuario' type='text' value={username} onChange={setUsername as any} className='text-gray-600' />
            <Input appearance='mate' color='purple' intensity={500} placeholder='Contraseña' type='password' value={password} onChange={setPassword as any} className='text-gray-600' />
            <Input appearance='mate' color='purple' intensity={500} placeholder='Confirmar contraseña' type='password' value={confirmPassword} onChange={setConfirmPassword as any} className='text-gray-600' />
            <Button appearance='mate' color='purple' intensity={700} className='text-gray-600' onClick={loading ? undefined : register}>{loading ? 'Registrando...' : 'Registrarse'}</Button>
            <Button appearance='mate' color='gray' intensity={700} className='text-gray-600' onClick={onLogin}>¿Ya tienes cuenta? Inicia sesión</Button>
        </>
    )
}