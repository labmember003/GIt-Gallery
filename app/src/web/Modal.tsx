import React, { useEffect, useRef } from 'react';
import { Icon } from './Icon';

export function Modal({ title, children, onClose, wide = false }: {
  title: string; children: React.ReactNode; onClose(): void; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const cancel = (event: Event) => { event.preventDefault(); close.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal${wide ? ' modal-wide' : ''}`} aria-label={title}
    onClick={(event) => { if (event.target === ref.current) onClose(); }}>
    <div className="modal-content">
      <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><Icon name="close" /></button></div>
      {children}
    </div>
  </dialog>;
}
