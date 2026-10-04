export function HashTag({ name }: { name: string }) {
    return (
        <span className="text-base t-secondary text-pretty overflow-hidden" >
            <div className="flex gap-0.5">
                <div className="text-sm opacity-70 italic">#</div>
                <div className="text-sm opacity-70">
                    {name}
                </div>
            </div>
        </span>
    )
}
