/** Workspace rename, SSH connection edit, and removal dialogs, keyed by their captured request. */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { parseSshWorkspaceAuthority, parseSshWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceActionRequest, WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

type Props = Pick<
  WorkspaceBrowserProps,
  'renameWorkspace' | 'deleteWorkspace' | 'deleteSession' | 'updateSshWorkspace' | 'reconnectSshWorkspace' | 'settleWorkspaceAction' | 't'
> & {
  request: WorkspaceActionRequest
  workspaces: readonly WorkspaceView[]
}

/** @param props - captured request, current Workspace list, and existing mutations. @returns the active dialog. */
export function WorkspaceDialogs({
  request, workspaces, renameWorkspace, deleteWorkspace, deleteSession, updateSshWorkspace, reconnectSshWorkspace, settleWorkspaceAction, t,
}: Props) {
  const composingRef = useRef(false)
  const renameTarget = request.action === 'rename' ? request : null
  const [renameDraft, setRenameDraft] = useState(request.displayTitle)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameTrimmed = renameDraft.trim()
  // Self is excluded by identity, not by title: the draft is seeded with the
  // localized label, which for an automatically titled Workspace equals its
  // own displayed title without being a conflict with itself.
  const renameDuplicate = renameTarget !== null && renameTrimmed !== ''
    && workspaces.some(w => w.workspaceId !== renameTarget.workspaceId && w.title === renameTrimmed)
  const renameBlocked = renaming || renameTrimmed === ''
    || renameTarget === null || renameTrimmed === renameTarget.storedTitle || renameDuplicate
  const closeRename = () => {
    if (renaming) return
    settleWorkspaceAction()
    setRenameError(null)
  }
  const confirmRename = () => {
    if (renameBlocked) return
    setRenaming(true)
    setRenameError(null)
    renameWorkspace(renameTarget.workspaceId, renameTrimmed).then(() => {
      setRenaming(false)
      settleWorkspaceAction()
    }).catch((reason: unknown) => {
      setRenaming(false)
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const editSshTarget = request.action === 'editSsh' ? request : null
  const initialSshLocation = editSshTarget === null ? undefined : parseSshWorkspacePath(editSshTarget.path)
  const initialSshAuthority = initialSshLocation === undefined ? undefined : parseSshWorkspaceAuthority(initialSshLocation.host)
  const [sshHost, setSshHost] = useState(initialSshAuthority?.host ?? '')
  const [sshPort, setSshPort] = useState(String(initialSshAuthority?.port ?? 22))
  const [sshUsername, setSshUsername] = useState(initialSshAuthority?.username ?? '')
  const [sshPassword, setSshPassword] = useState('')
  const [sshPath, setSshPath] = useState(initialSshLocation?.remotePath ?? '')
  const [savingSsh, setSavingSsh] = useState(false)
  const [sshError, setSshError] = useState<string | null>(null)
  const sshPortNumber = Number(sshPort)
  const sshValid = editSshTarget !== null && sshHost.trim() !== '' && sshUsername.trim() !== ''
    && sshPath.trim().startsWith('/') && Number.isInteger(sshPortNumber) && sshPortNumber >= 1 && sshPortNumber <= 65535
  const closeEditSsh = () => {
    if (savingSsh) return
    settleWorkspaceAction()
    setSshError(null)
  }
  const confirmEditSsh = () => {
    if (savingSsh || !sshValid || editSshTarget === null) return
    setSavingSsh(true)
    setSshError(null)
    updateSshWorkspace({
      workspaceId: editSshTarget.workspaceId,
      path: sshPath.trim(),
      ssh: {
        host: sshHost.trim(),
        port: sshPortNumber,
        username: sshUsername.trim(),
        ...(sshPassword === '' ? {} : { password: sshPassword }),
      },
    }).then(() => {
      setSavingSsh(false)
      setSshPassword('')
      settleWorkspaceAction()
    }).catch((reason: unknown) => {
      setSavingSsh(false)
      setSshError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const connectSshTarget = request.action === 'connectSsh' ? request : null
  const connectSshLocation = connectSshTarget === null ? undefined : parseSshWorkspacePath(connectSshTarget.path)
  const connectSshLabel = connectSshTarget === null
    ? ''
    : connectSshLocation === undefined
      ? connectSshTarget.displayTitle
      : `${connectSshTarget.displayTitle} (${connectSshLocation.host})`
  const [connectPassword, setConnectPassword] = useState('')
  const [connectingSsh, setConnectingSsh] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const closeConnectSsh = () => {
    if (connectingSsh) return
    setConnectPassword('')
    setConnectError(null)
    settleWorkspaceAction()
  }
  const confirmConnectSsh = () => {
    if (connectingSsh || connectSshTarget === null || connectPassword === '') return
    setConnectingSsh(true)
    setConnectError(null)
    reconnectSshWorkspace(connectSshTarget.workspaceId, connectPassword, connectSshTarget.sessionId).then(() => {
      setConnectingSsh(false)
      setConnectPassword('')
      settleWorkspaceAction()
    }).catch((reason: unknown) => {
      setConnectingSsh(false)
      setConnectError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const deleteTarget = request.action === 'delete' ? request : null
  const deleteSessionTarget = request.action === 'deleteSession' ? request : null
  const deletePath = deleteTarget === null ? undefined
    : workspaces.find(workspace => workspace.workspaceId === deleteTarget.workspaceId)?.path
  const deleteRemoteWorkspace = deletePath !== undefined && parseSshWorkspacePath(deletePath) !== undefined
  const deleteLocalWorkspace = deleteTarget !== null && !deleteRemoteWorkspace
  const deleteSessionPath = deleteSessionTarget === null ? undefined
    : workspaces.find(workspace => workspace.sessionIds.includes(deleteSessionTarget.sessionId))?.path
  const deleteRemoteSession = deleteSessionPath !== undefined && parseSshWorkspacePath(deleteSessionPath) !== undefined
  const [deleteLocalDirectory, setDeleteLocalDirectory] = useState(false)
  const deleteTitle = t(deleteSessionTarget !== null
    ? deleteRemoteSession ? 'delete.session.remote' : 'delete.session'
    : deleteRemoteWorkspace ? 'delete.remote' : 'delete.workspace')
  const deleteConfirmLabel = deleteLocalWorkspace
    ? t(deleteLocalDirectory ? 'delete.workspace.withFiles' : 'delete.workspace.clientOnly')
    : deleteTitle
  const [deleting, setDeleting] = useState(false)
  const [deleteCommittedId, setDeleteCommittedId] = useState<WorkspaceId | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => {
    if (deleteCommittedId === null
      || workspaces.some(workspace => workspace.workspaceId === deleteCommittedId)) return
    setDeleting(false)
    setDeleteCommittedId(null)
    settleWorkspaceAction()
  }, [deleteCommittedId, workspaces, settleWorkspaceAction])
  const closeDelete = () => {
    if (deleting) return
    settleWorkspaceAction()
    setDeleteLocalDirectory(false)
    setDeleteError(null)
  }
  const confirmDelete = () => {
    /* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
    if (deleting || (deleteTarget === null && deleteSessionTarget === null)) return
    setDeleting(true)
    setDeleteCommittedId(null)
    setDeleteError(null)
    const deletion = deleteSessionTarget === null
      ? deleteTarget === null
        ? Promise.resolve()
        : deleteRemoteWorkspace
          ? deleteWorkspace(deleteTarget.workspaceId)
          : deleteWorkspace(deleteTarget.workspaceId, { deleteDirectory: deleteLocalDirectory })
      : deleteSession(deleteSessionTarget.sessionId)
    deletion.then(() => {
      // Keep Workspace confirmation pending until its list projection commits.
      if (deleteTarget !== null) {
        setDeleteCommittedId(deleteTarget.workspaceId)
        return
      }
      setDeleting(false)
      settleWorkspaceAction()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setDeleteError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return <>
    <Modal
      open={renameTarget !== null}
      onClose={closeRename}
      closeLabel={t('close')}
      title={t('rename.workspace.title')}
      footer={(
        <>
          <Button variant="outline" disabled={renaming} onClick={closeRename}>{t('cancel')}</Button>
          <Button variant="primary" disabled={renameBlocked} onClick={confirmRename}>{t('rename')}</Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={renameDraft}
        aria-label={t('field.workspaceName')}
        data-modal-autofocus
        disabled={renaming}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setRenameDraft(e.target.value); setRenameError(null) }}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composingRef.current) {
            e.preventDefault()
            confirmRename()
          }
        }}
      />
      {renameDuplicate && (
        <div className={css.renameError} role="alert">{t('conflict.named', { name: renameTrimmed })}</div>
      )}
      {renameError !== null && <div className={css.renameError} role="alert">{renameError}</div>}
    </Modal>

    <Modal
      open={editSshTarget !== null}
      onClose={closeEditSsh}
      closeLabel={t('close')}
      title={t('ssh.edit.title')}
      description={t('ssh.edit.hint')}
      footer={(
        <>
          <Button variant="outline" disabled={savingSsh} onClick={closeEditSsh}>{t('cancel')}</Button>
          <Button variant="primary" disabled={savingSsh || !sshValid} onClick={confirmEditSsh}>
            {t(savingSsh ? 'ssh.edit.saving' : 'ssh.edit.submit')}
          </Button>
        </>
      )}
    >
      <div className={css.sshFormGrid}>
        <label className={css.sshField}>
          <span className={css.sshLabel}>{t('ssh.add.ip')}</span>
          <input
            className={css.renameInput}
            value={sshHost}
            placeholder="192.0.2.10"
            data-modal-autofocus
            disabled={savingSsh}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => { setSshHost(e.target.value); setSshError(null) }}
          />
        </label>
        <label className={css.sshField}>
          <span className={css.sshLabel}>{t('ssh.add.port')}</span>
          <input
            className={css.renameInput}
            type="number"
            min="1"
            max="65535"
            value={sshPort}
            disabled={savingSsh}
            onChange={(e) => { setSshPort(e.target.value); setSshError(null) }}
          />
        </label>
        <label className={css.sshField}>
          <span className={css.sshLabel}>{t('ssh.add.username')}</span>
          <input
            className={css.renameInput}
            value={sshUsername}
            disabled={savingSsh}
            autoComplete="username"
            spellCheck={false}
            onChange={(e) => { setSshUsername(e.target.value); setSshError(null) }}
          />
        </label>
        <label className={css.sshField}>
          <span className={css.sshLabel}>{t('ssh.add.password')}</span>
          <input
            className={css.renameInput}
            type="password"
            value={sshPassword}
            placeholder={t('ssh.edit.passwordPlaceholder')}
            disabled={savingSsh}
            autoComplete="current-password"
            onChange={(e) => { setSshPassword(e.target.value); setSshError(null) }}
          />
        </label>
        <label className={css.sshFieldFull}>
          <span className={css.sshLabel}>{t('ssh.add.path')}</span>
          <input
            className={css.renameInput}
            value={sshPath}
            placeholder={t('ssh.add.path.placeholder')}
            disabled={savingSsh}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => { setSshPath(e.target.value); setSshError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !composingRef.current) {
                e.preventDefault()
                confirmEditSsh()
              }
            }}
          />
        </label>
      </div>
      {sshError !== null && <div className={css.renameError} role="alert">{sshError}</div>}
    </Modal>

    <Modal
      open={connectSshTarget !== null}
      onClose={closeConnectSsh}
      closeLabel={t('close')}
      title={t('ssh.connect.title')}
      description={t('ssh.connect.hint', { target: connectSshLabel })}
      footer={(
        <>
          <Button variant="outline" disabled={connectingSsh} onClick={closeConnectSsh}>{t('cancel')}</Button>
          <Button variant="primary" disabled={connectingSsh || connectPassword === ''} onClick={confirmConnectSsh}>
            {t(connectingSsh ? 'ssh.connect.connecting' : 'ssh.connect.submit')}
          </Button>
        </>
      )}
    >
      <label className={css.sshFieldFull}>
        <span className={css.sshLabel}>{t('ssh.add.password')}</span>
        <input
          className={css.renameInput}
          type="password"
          value={connectPassword}
          placeholder={t('ssh.connect.passwordPlaceholder')}
          data-modal-autofocus
          disabled={connectingSsh}
          autoComplete="current-password"
          onChange={(e) => { setConnectPassword(e.target.value); setConnectError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composingRef.current) {
              e.preventDefault()
              confirmConnectSsh()
            }
          }}
        />
      </label>
      {connectError !== null && <div className={css.renameError} role="alert">{connectError}</div>}
    </Modal>

    <Modal
      open={deleteTarget !== null || deleteSessionTarget !== null}
      onClose={closeDelete}
      closeLabel={t('close')}
      title={deleteTitle}
      {...deleteTarget !== null
        ? {
          description: t(
            deleteRemoteWorkspace
              ? 'delete.remote.desc'
              : deleteLocalDirectory ? 'delete.desc' : 'delete.desc.keepFiles',
            { name: deleteTarget.displayTitle },
          ),
        }
        : deleteSessionTarget === null ? {} : {
          description: t(deleteRemoteSession ? 'delete.session.remote.desc' : 'delete.session.desc', {
            name: deleteSessionTarget.displayTitle,
          }),
        }}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={closeDelete}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={css.deleteAction}
            disabled={deleting}
            onClick={confirmDelete}
          >
            {deleteConfirmLabel}
          </Button>
        </>
      )}
    >
      {deleteLocalWorkspace && (
        <label className={deleteLocalDirectory ? `${css.deleteOption} ${css.deleteOptionDanger}` : css.deleteOption}>
          <input
            type="checkbox"
            className={css.deleteCheckbox}
            checked={deleteLocalDirectory}
            disabled={deleting}
            onChange={(e) => { setDeleteLocalDirectory(e.target.checked); setDeleteError(null) }}
          />
          <span className={css.deleteOptionText}>
            <span className={css.deleteOptionLabel}>{t('delete.localDirectoryOption')}</span>
            <span className={css.deleteOptionHint}>{t('delete.localDirectoryHint')}</span>
            {deletePath !== undefined && <span className={css.deleteOptionPath}>{deletePath}</span>}
          </span>
        </label>
      )}
      {deleting && <div className={css.deleteStatus} role="status">
        {deleteRemoteWorkspace || deleteRemoteSession
          ? deleteTitle
          : t(deleteLocalDirectory ? 'delete.pending' : 'delete.pending.keepFiles')}
      </div>}
      {deleteError !== null && <div className={css.renameError} role="alert">{deleteError}</div>}
    </Modal>
  </>
}
