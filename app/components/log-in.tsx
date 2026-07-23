"use client"
import { Button, Card, Input } from 'azeriand-library'
import useLogInStore from '../src/stores/log-in.store'

export default function LogIn() {

    const { email, password, setEmail, setPassword, login } = useLogInStore();

    return (
        <div className='flex flex-col gap-y-4 p-4 fixed w-full h-full items-center justify-center bg-white/20 z-70' style={{backdropFilter: 'blur(5px)'}}>
            <Card appearance='mate' color='white' intensity={200} className='flex flex-col gap-y-4 items-center' style={{boxShadow: "0 20px 40px rgba(0, 0, 0, 0.35)"}}>
                <h1 className='text-gray-600 text-lg'>Golden·Core</h1>
                <p className='text-sm text-gray-600'>Log in</p>
                <Input appearance='mate' color='purple' intensity={500} placeholder='Email' type='email' value={email} onChange={setEmail as any} className='text-gray-600' />
                <Input appearance='mate' color='purple' intensity={500} placeholder='Password' type='password' value={password} onChange={setPassword as any} className='text-gray-600' />
                <Button appearance='mate' color='purple' intensity={500} className='text-gray-600' onClick={login}>Log in</Button>
            </Card>
        </div>
    )
}