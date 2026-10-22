export function HashTag({ name }: { name: string }) {
    return (
        <span className="feed-hashtag t-secondary text-pretty">
            <span aria-hidden="true">#</span>
            <span>{name}</span>
        </span>
    )
}
