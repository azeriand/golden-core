"use client"
import { Button, Card, Input } from 'azeriand-library'
import useSignUpStore from '../src/stores/sign-up.store'

export default function SignUp() {
    const { email, password, username, confirmPassword, setEmail, setPassword, setUsername, setConfirmPassword, register} = useSignUpStore();

    return (
        <div className='flex flex-col gap-y-4 p-10 fixed w-full h-full items-center justify-center bg-black/80 z-50' style={{backdropFilter: 'blur(5px)'}}>
            <Card appearance='mate' color='white' intensity={200} className='flex flex-col gap-y-4 items-center' style={{boxShadow: "0 20px 40px rgba(0, 0, 0, 0.35)"}}>
                <h1 className='text-gray-600 text-lg'>Golden·Core</h1>
                <p className='text-sm text-gray-600'>Sign up</p>
                <Input appearance='mate' color='purple' intensity={500} placeholder='Email' type='email' value={email} onChange={setEmail as any} className='text-gray-600' />
                <Input appearance='mate' color='purple' intensity={500} placeholder='Username' type='text' value={username} onChange={setUsername as any} className='text-gray-600' />
                <Input appearance='mate' color='purple' intensity={500} placeholder='Password' type='password' value={password} onChange={setPassword as any} className='text-gray-600' />
                <Input appearance='mate' color='purple' intensity={500} placeholder='Confirm Password' type='password' value={confirmPassword} onChange={setConfirmPassword as any} className='text-gray-600' />
                <Button appearance='mate' color='purple' intensity={700} className='text-gray-600' onClick={register}>Sign up</Button>
            </Card>
        </div>
    )
}