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
            <p className='text-sm text-gray-600'>Sign up</p>
            <Input appearance='mate' color='purple' intensity={500} placeholder='Email' type='email' value={email} onChange={setEmail as any} className='text-gray-600' />
            <Input appearance='mate' color='purple' intensity={500} placeholder='Username' type='text' value={username} onChange={setUsername as any} className='text-gray-600' />
            <Input appearance='mate' color='purple' intensity={500} placeholder='Password' type='password' value={password} onChange={setPassword as any} className='text-gray-600' />
            <Input appearance='mate' color='purple' intensity={500} placeholder='Confirm Password' type='password' value={confirmPassword} onChange={setConfirmPassword as any} className='text-gray-600' />
            <Button appearance='mate' color='purple' intensity={700} className='text-gray-600' onClick={register} disabled={loading}>{loading ? 'Signing up...' : 'Sign up'}</Button>
            <Button appearance='mate' color='gray' intensity={700} className='text-gray-600' onClick={onLogin}>Already have an account? Log in</Button>
        </>
    )
}