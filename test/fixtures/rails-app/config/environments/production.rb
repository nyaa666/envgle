# Fixture source for envgle integration tests. Never loaded, never run.
Rails.application.configure do
  # A plain read: nil when the variable is absent, which breaks the deploy.
  database_url = ENV["DATABASE_URL"]

  config.force_ssl = true
  config.log_level = :info
  config.x.database_url = database_url
end
