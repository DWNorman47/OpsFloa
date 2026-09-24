import { useEffect, useState } from 'react';

/**
 * Returns `value`, but only after it has stopped changing for `delay` ms.
 * Use for search boxes so a fetch runs once per pause, not once per keystroke.
 */
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
