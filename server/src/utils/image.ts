export function extractImage(content: string) {
    const img_reg = /!\[.*?\]\((.*?)\)/;
    const img_match = img_reg.exec(content);
    let avatar: string | undefined = undefined;
    if (img_match && !img_match[1].startsWith('private-media:')) {
        avatar = img_match[1];
    }
    return avatar;
}
