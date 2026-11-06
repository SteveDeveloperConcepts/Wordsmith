import { PluginKey } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { BubbleMenu, type BubbleMenuProps } from '@tiptap/react/menus';
import { Sparkles } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { REWRITE_PRESETS } from '@shared/ai-types';
import { useAiReady } from '../ai/client';
import { selectedPassage, useAi } from '../state/ai';
import '../styles/ai.css';

const menuKey = new PluginKey('wordsmith-ai-menu');

/** Anything shorter is more likely a slip of the mouse than a passage to rewrite. */
const MIN_CHARACTERS = 3;

const shouldShow: NonNullable<BubbleMenuProps['shouldShow']> = ({ editor, element, view, state }) => {
  if (!editor.isEditable || !(view.hasFocus() || element.contains(document.activeElement))) return false;
  const { $from, $to } = state.selection;
  if ($from.parent.type.spec.code || $to.parent.type.spec.code) return false;
  // Using the menu again now would silently drop the rewrite already under way.
  if (useAi.getState().rewrite.status === 'running') return false;
  return selectedPassage(state).length >= MIN_CHARACTERS;
};

/** One object for good: the menu reconfigures itself whenever it is handed a new one. */
const MENU_OPTIONS: BubbleMenuProps['options'] = {
  // A selection taller than the page still needs its menu on screen.
  shift: { crossAxis: true, padding: 12 },
};

/** Quick AI actions, floating over the selected text. */
export function SelectionMenu({ editor }: { editor: Editor }) {
  const ready = useAiReady();

  // Someone who has not set up AI should not get a toolbar over every selection.
  if (!ready) return null;

  const hide = () => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(menuKey, 'hide'));
  };

  const runPreset = (id: string) => {
    const preset = REWRITE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const { showSection, runRewrite } = useAi.getState();
    showSection('rewrite');
    runRewrite(preset.instruction, preset.label);
    // Hiding takes the buttons away, and the keyboard with them if it was here.
    editor.view.focus();
    hide();
  };

  const askForInstruction = () => {
    useAi.getState().showSection('rewrite');
    useAi.setState({ focusInstruction: true });
    hide();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') editor.view.focus();
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={menuKey}
      className="ai-bubble"
      shouldShow={shouldShow}
      options={MENU_OPTIONS}
      // The menu's own wrapper passes a stand-in event here, so read the native one.
      onBlur={(event) => {
        const next = event.nativeEvent.relatedTarget;
        // The library only reacts when the editor itself blurs, which already happened on the way in.
        if (next instanceof Node && (event.currentTarget.contains(next) || editor.view.dom.contains(next))) return;
        // Not straight away: hiding the menu with the keyboard in it blurs it, part way through the hiding.
        queueMicrotask(hide);
      }}
    >
      <div
        className="ai-bubble__bar"
        role="toolbar"
        aria-label="Rewrite the selection with AI"
        // Keep the text selection while clicking the menu.
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
      >
        <Sparkles size={14} aria-hidden className="ai-bubble__icon" />
        <button type="button" className="ai-bubble__button" onClick={() => runPreset('improve')}>
          Improve
        </button>
        <button type="button" className="ai-bubble__button" onClick={() => runPreset('shorten')}>
          Shorten
        </button>
        <button type="button" className="ai-bubble__button" onClick={askForInstruction}>
          Rewrite
        </button>
      </div>
    </BubbleMenu>
  );
}
