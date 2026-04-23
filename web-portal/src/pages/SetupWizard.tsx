import { useTranslation } from 'react-i18next'
import { useSetupWizard } from '../hooks/useSetupWizard'
import { useDirectoryBrowser } from '../hooks/useDirectoryBrowser'
import ProgressBar from './setup/ProgressBar'
import WelcomeStep from './setup/WelcomeStep'
import ProvidersStep from './setup/ProvidersStep'
import ProjectPathStep from './setup/ProjectPathStep'
import ChannelRagStep from './setup/ChannelRagStep'
import ReviewStep from './setup/ReviewStep'
import DirectoryBrowser from './setup/DirectoryBrowser'


export default function SetupWizard() {
  const { t } = useTranslation('setup')
  const wiz = useSetupWizard()
  const browser = useDirectoryBrowser()

  const handleBrowserSelect = () => {
    const selected = browser.selectFolder()
    wiz.setProjectPath(selected)
  }

  if (wiz.setupAvailability !== 'available') {
    return (
      <div className="setup-container">
        <div className="setup-card">
          <div className="setup-card-body">
            <h1>
              {wiz.setupAvailability === 'checking'
                ? t('wizard.checking.title')
                : t('wizard.unavailable.title')}
            </h1>
            <p>
              {wiz.setupAvailability === 'checking'
                ? t('wizard.checking.description')
                : wiz.setupUnavailableReason}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="setup-container">
      <div className="setup-card">
        <div className="setup-card-body">
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
            providerAuthModes={wiz.providerAuthModes}
            providerModels={wiz.providerModels}
            setProviderKey={wiz.setProviderKey}
            setProviderAuthMode={wiz.setProviderAuthMode}
            setProviderModel={wiz.setProviderModel}
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
            pathIsUnityProject={wiz.pathIsUnityProject}
            pathStradaDeps={wiz.pathStradaDeps}
            pathDependencyWarnings={wiz.pathDependencyWarnings}
            pathMcpRecommendation={wiz.pathMcpRecommendation}
            mcpInstallStatus={wiz.mcpInstallStatus}
            mcpInstallError={wiz.mcpInstallError}
            mcpInstallMessage={wiz.mcpInstallMessage}
            mcpInstallPlan={wiz.mcpInstallPlan}
            depInstallStatus={wiz.depInstallStatus}
            depInstallError={wiz.depInstallError}
            validatePath={wiz.validatePath}
            installMcp={wiz.installMcp}
            installDep={wiz.installDep}
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
            embeddingModel={wiz.embeddingModel}
            setEmbeddingModel={wiz.setEmbeddingModel}
            checkedProviders={wiz.checkedProviders}
            providerKeys={wiz.providerKeys}
            providerAuthModes={wiz.providerAuthModes}
            setProviderKey={wiz.setProviderKey}
            daemonEnabled={wiz.daemonEnabled}
            setDaemonEnabled={wiz.setDaemonEnabled}
            autonomyEnabled={wiz.autonomyEnabled}
            setAutonomyEnabled={wiz.setAutonomyEnabled}
            autonomyHours={wiz.autonomyHours}
            setAutonomyHours={wiz.setAutonomyHours}
            daemonBudget={wiz.daemonBudget}
            setDaemonBudget={wiz.setDaemonBudget}
            globalDailyBudget={wiz.globalDailyBudget}
            setGlobalDailyBudget={wiz.setGlobalDailyBudget}
            onNext={wiz.nextStep}
            onBack={wiz.prevStep}
          />
        )}

        {wiz.step === 5 && (
          <ReviewStep
            selectedPreset={wiz.selectedPreset}
            checkedProviders={wiz.checkedProviders}
            providerKeys={wiz.providerKeys}
            providerAuthModes={wiz.providerAuthModes}
            providerModels={wiz.providerModels}
            projectPath={wiz.projectPath}
            channel={wiz.channel}
            language={wiz.language}
            ragEnabled={wiz.ragEnabled}
            embeddingProvider={wiz.embeddingProvider}
            globalDailyBudget={wiz.globalDailyBudget}
            daemonEnabled={wiz.daemonEnabled}
            daemonBudget={wiz.daemonBudget}
            autonomyEnabled={wiz.autonomyEnabled}
            autonomyHours={wiz.autonomyHours}
            saveStatus={wiz.saveStatus}
            saveError={wiz.saveError}
            saveWarning={wiz.saveWarning}
            bootstrapDetail={wiz.bootstrapDetail}
            readyUrl={wiz.readyUrl}
            saveCommitted={wiz.saveCommitted}
            canSave={wiz.canSave}
            saveBlockingReason={wiz.reviewBlockingReason}
            onBack={wiz.prevStep}
            onSave={wiz.save}
          />
        )}
        </div>
      </div>

      {browser.isOpen && (
        <DirectoryBrowser
          isOpen={browser.isOpen}
          currentPath={browser.currentPath}
          entries={browser.entries}
          isUnityProject={browser.isUnityProject}
          stradaDeps={browser.stradaDeps}
          dependencyWarnings={browser.dependencyWarnings}
          mcpRecommendation={browser.mcpRecommendation}
          mcpInstallStatus={wiz.mcpInstallStatus}
          mcpInstallError={wiz.mcpInstallError}
          mcpInstallMessage={wiz.mcpInstallMessage}
          mcpInstallPlan={wiz.mcpInstallPlan}
          depInstallStatus={wiz.depInstallStatus}
          depInstallError={wiz.depInstallError}
          loading={browser.loading}
          error={browser.error}
          browseTo={browser.browseTo}
          installMcp={wiz.installMcp}
          installDep={wiz.installDep}
          onSelect={handleBrowserSelect}
          onClose={browser.close}
        />
      )}
    </div>
  )
}
