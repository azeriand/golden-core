"use client"
import { Button, Card, Input } from 'azeriand-library'
import useSignUpStore from '../src/stores/sign-up.store'

    interface Props {
        onLogin: () => void;
    }

export default function SignUp({ onLogin }: Props) {
    const { email, password, username, confirmPassword, loading, error, errorFields, setEmail, setPassword, setUsername, setConfirmPassword, register} = useSignUpStore();

    const fieldStyle = (field: string) => errorFields.includes(field)
        ? { color: '#FFFCF8', borderColor: '#F87171' }
        : { color: '#FFFCF8' };

    const fieldClass = (field: string) => `border-thin! rounded-xl! py-1! px-3! text-xs! ${errorFields.includes(field) ? 'ring-1! ring-red-400!' : ''}`;

    return (
        <>
            <p className='text-sm text-gray-600'>Crear cuenta</p>
            <div className="flex flex-col gap-y-2 w-full my-4">
                <Input appearance='mate' color='amber' intensity={700} placeholder='Email' type='email' value={email} onChange={setEmail as any} className={fieldClass('email')} style={fieldStyle('email')} />
                <Input appearance='mate' color='amber' intensity={700} placeholder='Nombre de usuario' type='text' value={username} onChange={setUsername as any} className={fieldClass('username')} style={fieldStyle('username')} />
                <Input appearance='mate' color='amber' intensity={700} placeholder='Contraseña' type='password' value={password} onChange={setPassword as any} className={fieldClass('password')} style={fieldStyle('password')} />
                <Input appearance='mate' color='amber' intensity={700} placeholder='Confirmar contraseña' type='password' value={confirmPassword} onChange={setConfirmPassword as any} className={fieldClass('confirmPassword')} style={fieldStyle('confirmPassword')} />
                {error && <p className='text-red-400 text-xs text-center'>{error}</p>}
            </div>
            <Button appearance='mate' color='purple' intensity={700} className='text-gray-600' onClick={loading ? undefined : register}>{loading ? 'Registrando...' : 'Registrarse'}</Button>
            <Button appearance='ghost' color='gray' intensity={500} className='text-gray-400! text-xs!' onClick={onLogin}>¿Ya tienes cuenta? <span className="text-purple-700">Inicia sesión</span></Button>
        </>
    )
}
