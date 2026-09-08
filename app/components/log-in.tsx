"use client"
import { Button, Card, Input } from 'azeriand-library'
import useLogInStore from '../src/stores/log-in.store'

    interface Props {
        onSignup: () => void;
    }
export default function LogIn({ onSignup }: Props) {

    const { email, password, loading, error, errorFields, setEmail, setPassword, login } = useLogInStore();

    const fieldStyle = (field: string) => errorFields.includes(field)
        ? { color: '#FFFCF8', borderColor: '#F87171' }
        : { color: '#FFFCF8' };

    const fieldClass = (field: string) => `border-thin! rounded-xl! py-1! px-3! text-base! ${errorFields.includes(field) ? 'ring-1! ring-red-400!' : ''}`;

    return (
        <>
            <p className='text-sm text-gray-600'>Iniciar sesión</p>
            <div className="flex flex-col gap-y-2 w-full max-w-56 my-4">
                <Input appearance='mate' color='amber' intensity={700} placeholder='Email' type='email' value={email} onChange={setEmail as any} className={fieldClass('email')} style={fieldStyle('email')} />
                <Input appearance='mate' color='amber' intensity={700} placeholder='Contraseña' type='password' value={password} onChange={setPassword as any} className={fieldClass('password')} style={fieldStyle('password')} />
                {error && <p className='text-red-400 text-xs text-center'>{error}</p>}
            </div>
            <Button appearance='mate' color='purple' intensity={500} className='text-gray-600' onClick={loading ? undefined : login}>{loading ? 'Iniciando...' : 'Iniciar sesión'}</Button>
            <Button appearance='ghost' color='gray' intensity={500} className='text-gray-400! text-xs!' onClick={onSignup}>¿No tienes cuenta? <span className="text-purple-700">Regístrate</span></Button>
        </>
    )
}
