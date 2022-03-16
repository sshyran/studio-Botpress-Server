import { Button, Icon } from '@blueprintjs/core'
import { lang, ModuleUI } from 'botpress/shared'
import React from 'react'

import style from '../style.scss'

const { KeyboardShortcut, SplashScreen } = ModuleUI

export default ({ hasRawPermissions, isAdvanced, setAdvanced }) => (
  <SplashScreen
    icon={<Icon icon="code" iconSize={140} />}
    title={lang.tr('code-editor.splash.codeEditor')}
    description={
      isAdvanced ? (
        <span>
          <span className={style.warning}>{lang.tr('code-editor.splash.bigWarning')}</span>
          <br />
          {lang.tr('code-editor.splash.rawEditorDesc')}
        </span>
      ) : (
        lang.tr('code-editor.splash.editorDesc')
      )
    }
  >
    <KeyboardShortcut label={lang.tr('code-editor.splash.saveFile')} keys={['ACTION', 's']} />
    <KeyboardShortcut label={lang.tr('code-editor.splash.newFile')} keys={['ACTION', 'alt', 'n']} />
    <KeyboardShortcut label={lang.tr('code-editor.splash.commandPalette')} keys={['ACTION', 'shift', 'p']} />
    <br />
    {hasRawPermissions && (
      <div>
        <Button
          text={isAdvanced ? lang.tr('code-editor.splash.basicEditor') : lang.tr('code-editor.splash.advancedEditor')}
          onClick={() => setAdvanced(!isAdvanced)}
        />
      </div>
    )}
  </SplashScreen>
)