import { useState } from 'react';
import ReactModal from 'react-modal';

export function TOCHeader({ TOC }: { TOC: () => JSX.Element }) {
  const [isOpened, setIsOpened] = useState(false);
  return (
    <div className="lg:hidden">
      <button onClick={() => setIsOpened(true)} className="w-10 h-10 rounded-full flex flex-row items-center justify-center">
        <i className="ri-menu-2-fill t-primary ri-lg" />
      </button>
      <ReactModal
        isOpen={isOpened}
        style={{
          content: {
            top: '50%', left: '50%', right: 'auto', bottom: 'auto',
            marginRight: '-50%', transform: 'translate(-50%, -50%)',
            padding: '0', border: 'none', borderRadius: '16px',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            alignItems: 'center', background: 'none',
          },
          overlay: { backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 1000 },
        }}
        onRequestClose={() => setIsOpened(false)}
      >
        <div className="w-[80vw] sm:w-[60vw] lg:w-[40vw] overflow-clip relative t-primary"><TOC /></div>
      </ReactModal>
    </div>
  );
}
