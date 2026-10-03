/** 正在执行任务或保存，不能再发起新的写操作。 */
export const isBusy = (s: { running: boolean; agentRunning: boolean; importRunning: boolean; saving: boolean }) =>
  s.running || s.agentRunning || s.importRunning || s.saving;

/** 有未保存的编辑。 */
export const isDirty = (s: { mappingDirty: boolean; settingsDirty: boolean; boqDirty: boolean }) =>
  s.mappingDirty || s.settingsDirty || s.boqDirty;
