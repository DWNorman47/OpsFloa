import { useState } from 'react';

// Native HTML5 drag-to-reorder for a list. `onReorder(fromIdx, toIdx)` performs the move.
// dragProps(idx) → handlers to spread on the draggable/drop element; isOver(idx) and
// isDragging(idx) → styling flags for feedback.
export function useDragReorder(onReorder) {
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const reset = () => { setDragIdx(null); setOverIdx(null); };
  const dragProps = (idx) => ({
    onDragStart: () => setDragIdx(idx),
    onDragOver: (e) => { e.preventDefault(); if (overIdx !== idx) setOverIdx(idx); },
    onDrop: (e) => { e.preventDefault(); if (dragIdx != null && dragIdx !== idx) onReorder(dragIdx, idx); reset(); },
    onDragEnd: reset,
  });
  return {
    dragProps,
    isOver: (idx) => overIdx === idx && dragIdx != null && dragIdx !== idx,
    isDragging: (idx) => dragIdx === idx,
  };
}
