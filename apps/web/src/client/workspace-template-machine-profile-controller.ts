import { Controller } from "@hotwired/stimulus";
import type { ToggleChangeEvent } from "@agents-in-the-cloud/design-system/toggle/client";

/** Containers have no extra disks, so choosing one clears them; choosing a virtual machine again brings them back. */
export class WorkspaceTemplateMachineProfileController extends Controller<HTMLFormElement> {
  static targets = ["disks"];
  static values = { vmDisks: String };
  declare readonly disksTarget: HTMLInputElement;
  /** What a new virtual machine profile starts with. */
  declare readonly vmDisksValue: string;
  /** The disks to bring back for a virtual machine. */
  private disks = "";

  connect(): void {
    this.disks = this.disksTarget.value || this.vmDisksValue;
  }

  typeChanged(event: ToggleChangeEvent): void {
    if (event.detail.value === "container") {
      if (this.disksTarget.value) this.disks = this.disksTarget.value;
      this.disksTarget.value = "";
    } else if (!this.disksTarget.value) {
      this.disksTarget.value = this.disks;
    }
  }
}
