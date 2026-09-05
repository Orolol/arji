import * as React from "react";

/**
 * Inline stand-in for `@/components/ui/dropdown-menu`.
 *
 * WHY MOCK IT AT ALL: the real menu is Radix, which portals its items only
 * once open. A test asserting that an option is ABSENT — the whole point of
 * the picker's `dispatch` mode — would pass vacuously against the real menu,
 * for every option, in every mode. Rendering the items inline makes absence a
 * real question.
 *
 * WHY SHARED: four test files carried a near-identical copy of this, and the
 * copies could not all be right about a primitive none of them owned. When
 * `AgentSelectPill` moved to radio items, every copy broke the same way.
 *
 * `DropdownMenuRadioItem` reproduces the two things the real one contributes
 * to the assertions here: `role="menuitemradio"` and `aria-checked` against
 * the enclosing group's value. Without the context the mock would render a
 * radio item that is never checked, and a test could then "prove" a selected
 * state the user never sees.
 */
const RadioGroupValue = React.createContext<string | undefined>(undefined);

type Children = { children?: React.ReactNode };

export function dropdownMenuModuleMock() {
  return {
    DropdownMenu: ({ children }: Children) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: Children) => <>{children}</>,
    DropdownMenuContent: ({ children }: Children) => (
      <div data-testid="dropdown-content">{children}</div>
    ),
    DropdownMenuLabel: ({ children }: Children) => (
      <div data-testid="dropdown-label">{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      onSelect,
      ...rest
    }: Children & { onSelect?: () => void }) => (
      <button type="button" role="menuitem" onClick={() => onSelect?.()} {...rest}>
        {children}
      </button>
    ),
    DropdownMenuRadioGroup: ({
      value,
      children,
    }: Children & { value?: string }) => (
      <RadioGroupValue.Provider value={value}>
        {children}
      </RadioGroupValue.Provider>
    ),
    DropdownMenuRadioItem: ({
      children,
      onSelect,
      value,
      ...rest
    }: Children & { onSelect?: () => void; value?: string }) => {
      const checked = React.useContext(RadioGroupValue) === value;
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={checked}
          onClick={() => onSelect?.()}
          {...rest}
        >
          {children}
        </button>
      );
    },
  };
}
