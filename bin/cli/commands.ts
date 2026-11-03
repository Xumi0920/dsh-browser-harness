import type { CliCommand } from "./registry.js";
import { doctorCommand } from "./commands/doctor.js";
import { statusCommand } from "./commands/status.js";
import { navigateCommand } from "./commands/navigate.js";
import { infoCommand } from "./commands/info.js";
import { tabsCommand } from "./commands/tabs.js";
import { closeCommand } from "./commands/close.js";
import { groupsCommand } from "./commands/groups.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { textCommand } from "./commands/text.js";
import { jsCommand } from "./commands/js.js";
import { extractCommand } from "./commands/extract.js";
import { waitCommand } from "./commands/wait.js";
import { actCommand } from "./commands/act.js";
import { shotCommand } from "./commands/shot.js";
import { pdfCommand } from "./commands/pdf.js";
import { diagnoseCommand } from "./commands/diagnose.js";
import { uploadCommand } from "./commands/upload.js";
import { downloadCommand } from "./commands/download.js";
import { taskCommand } from "./commands/task.js";

export const commands: CliCommand[] = [
  doctorCommand,
  statusCommand,
  navigateCommand,
  infoCommand,
  tabsCommand,
  closeCommand,
  groupsCommand,
  snapshotCommand,
  textCommand,
  jsCommand,
  extractCommand,
  waitCommand,
  actCommand,
  shotCommand,
  pdfCommand,
  diagnoseCommand,
  uploadCommand,
  downloadCommand,
  taskCommand,
];
