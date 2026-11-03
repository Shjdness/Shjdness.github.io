import {useEffect,useState} from 'react';
/** Changes entry links/selection only. Never redirects or remounts an editor
 * when a phone rotates or a desktop window is resized. Keep in sync with CSS. */
export function useMobileViewport(){
 const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 767px)').matches);
 useEffect(()=>{const media=window.matchMedia('(max-width: 767px)'),change=()=>setMobile(media.matches);change();media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
 return mobile;
}
