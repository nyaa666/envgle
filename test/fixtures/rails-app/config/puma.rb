# Fixture source for envgle integration tests. Never loaded, never run.
port = ENV["PORT"] || 3000
environment ENV.fetch("RAILS_ENV", "development")

bind "tcp://0.0.0.0:#{port}"
