
export function Input({ autofocus, value, setValue, className, placeholder, onSubmit, type = 'text' }:
    { autofocus?: boolean, value: string, className?: string, placeholder: string, id?: number, setValue: (v: string) => void, onSubmit?: () => void, type?: React.HTMLInputTypeAttribute }) {
    return (<input
        type={type}
        autoFocus={autofocus}
        placeholder={placeholder}
        value={value}
        onKeyDown={(event) => {
            if (event.key === 'Enter' && onSubmit) {
                onSubmit()
            }
        }}
        onChange={(event) => {
            setValue(event.target.value)
        }}
        className={'bg-secondary w-full py-2 px-4 rounded-xl t-primary ' + (className || '')} />
    )
}
export function Checkbox({ value, setValue, className, placeholder }:
    { value: boolean, className?: string, placeholder: string, id: string, setValue: React.Dispatch<React.SetStateAction<boolean>> }) {
    return (<input type='checkbox'
        placeholder={placeholder}
        checked={value}
        onChange={(event) => {
            setValue(event.target.checked)
        }}
        className={className} />
    )
}
