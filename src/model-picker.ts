import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Spacer, Text, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { AvailableImageModelItem } from "./inspect.ts";

type PickerDone = (value: string | undefined) => void;

export class InspectImageModelPicker extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly listContainer = new Container();
  private readonly footer = new Text();
  private filteredModels: AvailableImageModelItem[];
  private selectedIndex = 0;
  private focusedValue = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly models: AvailableImageModelItem[],
    private readonly done: PickerDone,
    initialSearch = "",
  ) {
    super();
    this.filteredModels = models;

    this.addChild(new Text(theme.fg("accent", theme.bold("Select inspect_image model")), 0, 0));
    this.addChild(new Text(theme.fg("muted", "Type to filter, Enter to select, Escape to cancel"), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);

    this.searchInput.onSubmit = () => this.selectCurrent();
    this.searchInput.onEscape = () => this.done(undefined);
    if (initialSearch) this.searchInput.setValue(initialSearch);
    this.filterModels();
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.searchInput.focused = value;
  }

  handleInput(keyData: string): void {
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }

    if (this.keybindings.matches(keyData, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }

    if (this.keybindings.matches(keyData, "tui.select.pageUp")) {
      this.moveSelection(-10);
      return;
    }

    if (this.keybindings.matches(keyData, "tui.select.pageDown")) {
      this.moveSelection(10);
      return;
    }

    if (this.keybindings.matches(keyData, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }

    if (this.keybindings.matches(keyData, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    this.searchInput.handleInput(keyData);
    this.filterModels();
  }

  private filterModels(): void {
    const query = this.searchInput.getValue();
    this.filteredModels = query
      ? fuzzyFilter(this.models, query, (model) => `${model.provider} ${model.id} ${model.name} ${model.ref}`)
      : this.models;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
    this.updateList();
  }

  private moveSelection(delta: number): void {
    if (this.filteredModels.length === 0) return;
    const length = this.filteredModels.length;
    this.selectedIndex = (this.selectedIndex + delta + length) % length;
    this.updateList();
  }

  private selectCurrent(): void {
    const selected = this.filteredModels[this.selectedIndex];
    if (selected) this.done(selected.ref);
  }

  private updateList(): void {
    this.listContainer.clear();

    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

    for (let i = startIndex; i < endIndex; i++) {
      const model = this.filteredModels[i];
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "-> ") : "   ";
      const id = isSelected ? this.theme.fg("accent", model.id) : model.id;
      const provider = this.theme.fg("muted", `[${model.provider}]`);
      this.listContainer.addChild(new Text(`${prefix}${id} ${provider}`, 0, 0));
    }

    if (this.filteredModels.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "No matching logged-in image-capable models"), 0, 0));
      this.footer.setText("");
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(new Text(this.theme.fg("muted", `Model Name: ${selected.name}`), 0, 0));
      this.footer.setText(this.theme.fg("muted", `${this.selectedIndex + 1}/${this.filteredModels.length}`));
    }

    this.tui.requestRender();
  }
}

export function createInspectImageModelPicker(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  models: AvailableImageModelItem[],
  done: PickerDone,
  initialSearch = "",
): Component & Focusable {
  return new InspectImageModelPicker(tui, theme, keybindings, models, done, initialSearch);
}
