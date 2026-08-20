"use client"
import { Button, Card, Input } from 'azeriand-library'
import useLogInStore from '../src/stores/log-in.store'

    interface Props {
        onSignup: () => void;
    }
export default function LogIn({ onSignup }: Props) {

    const { email, password, loading, setEmail, setPassword, login } = useLogInStore();

    return (
        <>
            <p className='text-sm text-gray-600'>Log in</p>
            <Input appearance='mate' color='purple' intensity={500} placeholder='Email' type='email' value={email} onChange={setEmail as any} className='text-gray-600' />
            <Input appearance='mate' color='purple' intensity={500} placeholder='Password' type='password' value={password} onChange={setPassword as any} className='text-gray-600' />
            <Button appearance='mate' color='purple' intensity={500} className='text-gray-600' onClick={login} disabled={loading}>{loading ? 'Logging in...' : 'Log in'}</Button>
            <Button appearance='mate' color='gray' intensity={700} className='text-gray-600' onClick={onSignup}>Don't have an account? Sign up</Button>
        </>
    )
}