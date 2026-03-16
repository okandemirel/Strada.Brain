import { useSetupWizard } from '../hooks/useSetupWizard'
import { useDirectoryBrowser } from '../hooks/useDirectoryBrowser'
import ProgressBar from './setup/ProgressBar'
import WelcomeStep from './setup/WelcomeStep'
import ProvidersStep from './setup/ProvidersStep'
import ProjectPathStep from './setup/ProjectPathStep'
import ChannelRagStep from './setup/ChannelRagStep'
import ReviewStep from './setup/ReviewStep'
import DirectoryBrowser from './setup/DirectoryBrowser'
import '../styles/setup.css'

export default function SetupWizard() {
  const wiz = useSetupWizard()
  const browser = useDirectoryBrowser()

  const handleBrowserSelect = () => {
    const selected = browser.selectFolder()
    wiz.setProjectPath(selected)
  }

  return (
    <div className="setup-container">
      <div className="setup-card">
        <ProgressBar step={wiz.step} totalSteps={5} />

        {wiz.step === 1 && (
          <WelcomeStep onNext={wiz.nextStep} />
        )}

        {wiz.step === 2 && (
          <ProvidersStep
            selectedPreset={wiz.selectedPreset}
            selectPreset={wiz.selectPreset}
            checkedProviders={wiz.checkedProviders}
            toggleProvider={wiz.toggleProvider}
            providerKeys={wiz.providerKeys}
            setProviderKey={wiz.setProviderKey}
            onNext={wiz.nextStep}
            onBack={wiz.prevStep}
          />
        )}

        {wiz.step === 3 && (
          <ProjectPathStep
            projectPath={wiz.projectPath}
            setProjectPath={wiz.setProjectPath}
            pathValid={wiz.pathValid}
            pathError={wiz.pathError}
            validatePath={wiz.validatePath}
            openBrowser={browser.open}
            onNext={wiz.nextStep}
            onBack={wiz.prevStep}
          />
        )}

        {wiz.step === 4 && (
          <ChannelRagStep
            channel={wiz.channel}
            setChannel={wiz.setChannel}
            channelConfig={wiz.channelConfig}
            setChannelConfigField={wiz.setChannelConfigField}
            language={wiz.language}
            setLanguage={wiz.setLanguage}
            ragEnabled={wiz.ragEnabled}
            setRagEnabled={wiz.setRagEnabled}
            embeddingProvider={wiz.embeddingProvider}
            setEmbeddingProvider={wiz.setEmbeddingProvider}
            checkedProviders={wiz.checkedProviders}
            daemonEnabled={wiz.daemonEnabled}
            setDaemonEnabled={wiz.setDaemonEnabled}
            autonomyEnabled={wiz.autonomyEnabled}
            setAutonomyEnabled={wiz.setAutonomyEnabled}
            autonomyHours={wiz.autonomyHours}
            setAutonomyHours={wiz.setAutonomyHours}
            daemonBudget={wiz.daemonBudget}
            setDaemonBudget={wiz.setDaemonBudget}
            onNext={wiz.nextStep}
            onBack={wiz.prevStep}
          />
        )}

        {wiz.step === 5 && (
          <ReviewStep
            selectedPreset={wiz.selectedPreset}
            checkedProviders={wiz.checkedProviders}
            providerKeys={wiz.providerKeys}
            projectPath={wiz.projectPath}
            channel={wiz.channel}
            language={wiz.language}
            ragEnabled={wiz.ragEnabled}
            embeddingProvider={wiz.embeddingProvider}
            daemonEnabled={wiz.daemonEnabled}
            daemonBudget={wiz.daemonBudget}
            autonomyEnabled={wiz.autonomyEnabled}
            autonomyHours={wiz.autonomyHours}
            saveStatus={wiz.saveStatus}
            saveError={wiz.saveError}
            onBack={wiz.prevStep}
            onSave={wiz.save}
          />
        )}
      </div>

      {browser.isOpen && (
        <DirectoryBrowser
          isOpen={browser.isOpen}
          currentPath={browser.currentPath}
          entries={browser.entries}
          isUnityProject={browser.isUnityProject}
          loading={browser.loading}
          error={browser.error}
          browseTo={browser.browseTo}
          onSelect={handleBrowserSelect}
          onClose={browser.close}
        />
      )}
    </div>
  )
}
