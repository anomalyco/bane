# Rebuild offline with the Ruby standard library:
#   ruby scripts/refresh-email-support.rb /path/to/caniemail
# Source archive: https://github.com/hteumeuleu/caniemail/archive/cb8109c3f8658e003aa064b47a71b232ddc28d39.tar.gz
# To upgrade, review a new upstream revision and change both pins together.
require 'date'
require 'digest'
require 'fileutils'
require 'json'
require 'yaml'

REVISION = 'cb8109c3f8658e003aa064b47a71b232ddc28d39'
INPUT_SHA256 = '753fe23534f9fd05f582ec7ab92cacdc61bc8b709bc86482b74ef074778eaefd'
OUTPUT = File.expand_path('../src/email-preview/vendor/caniemail', __dir__)
CLIENTS = {
  'gmail-web' => %w[gmail desktop-webmail],
  'gmail-ios' => %w[gmail ios],
  'gmail-android' => %w[gmail android],
  'gmail-ios-non-google' => %w[gmail ios],
  'gmail-android-non-google' => %w[gmail android],
  'apple-mail-macos' => %w[apple-mail macos],
  'apple-mail-ios' => %w[apple-mail ios],
  'outlook-web' => %w[outlook outlook-com],
  'outlook-new-windows' => nil, # No upstream column. Neither outlook-com nor windows-mail measures this client.
  'outlook-mac' => %w[outlook macos],
  'outlook-classic-windows' => %w[outlook windows],
  'yahoo-web' => %w[yahoo desktop-webmail],
  'aol-web' => %w[aol desktop-webmail],
  'samsung-email' => %w[samsung-email android],
}.freeze

def latest(stats, source)
  versions = stats.dig(*source) || {}
  # Outlook 2003 predates the Word engine used in 2007 and later.
  versions = versions.reject { |v, _| v == '2003' } if source == %w[outlook windows]
  keys = versions.keys
  # Compare like formats numerically. Outlook Mac mixes Office releases, dates,
  # and 16.x builds; for mixed schemes upstream specifies oldest-first order.
  key = if keys.all? { |v| v.match?(/\A\d{4}-\d{2}\z/) }
          keys.max
        elsif keys.all? { |v| v.match?(/\A\d+(?:\.\d+)*\z/) } &&
              !(keys.any? { |v| v.match?(/\A20\d{2}\z/) } && keys.any? { |v| v.include?('.') })
          keys.max_by { |v| v.split('.').map(&:to_i) }
        else
          keys.last
        end
  [key, versions.fetch(key)] if key
end

# The iOS/Android column is shared by both account profiles. Split its aggregate
# partial only when an attached note actually describes an account difference.
# Remaining caveats still apply; a restricted value isn't a ban on the property.
def gmail_code(raw, notes, non_google)
  base, *refs = raw.split
  return base unless base == 'a'

  account_codes = []
  other_caveats = false
  refs.each do |ref|
    text = notes[ref.delete_prefix('#')].to_s.sub(/\A(?:Partial|Partially supported)\. /i, '')
    case text
    when /\A(?:Not supported|Doesn't work|Does not render|Does not submit in iOS) with non Google accounts\.(?: But it can be used in the `background` shorthand property instead\.)?\z/i
      account_codes << 'n'
    when /\A(?:Only (?:supported|works) with non Google accounts|Supported with non Google accounts only)\.\z/i
      account_codes << 'y'
    when /non[- ](?:Google|Gmail) accounts?/i
      # Inline-only, or particular values aren't supported. Do not automatically
      # upgrade either profile for a new/unreviewed account-specific note.
      if text.start_with?('Only supported inline when', '`<style>` tag not supported', '`flex`, `grid`', 'Flow-relative values')
        account_codes << 'a'
      else
        raise "Review unrecognized Gmail account note: #{text}"
      end
    else
      other_caveats = true
    end
  end
  return base if account_codes.empty?
  return 'n' if non_google ? account_codes.include?('n') : account_codes.include?('y')
  return 'a' if other_caveats || (non_google && account_codes.include?('a'))
  'y'
end

abort 'Usage: ruby scripts/refresh-email-support.rb /path/to/caniemail' unless ARGV.size == 1
Dir.chdir(ARGV.first) do
  paths = Dir['_features/*.md'].sort
  digest = Digest::SHA256.new
  (['LICENSE'] + paths).each { |p| digest << p << "\0" << File.binread(p) << "\0" }
  abort "Unexpected input SHA256 #{digest.hexdigest}; expected Can I email #{REVISION}" unless digest.hexdigest == INPUT_SHA256

  rows = {}
  evidence = {}
  paths.reject { |p| File.basename(p).start_with?('_') }.each do |path|
    key = File.basename(path, '.md')
    front_matter = File.read(path, encoding: 'UTF-8').split(/^---\s*$/, 3).fetch(1)
    data = YAML.safe_load(front_matter.gsub(/^[ \t]+/) { |indent| indent.tr("\t", ' ') }, permitted_classes: [Date])
    notes = data.fetch('notes_by_num', {})
    cells = CLIENTS.values.compact.uniq.to_h { |source| [source, latest(data.fetch('stats'), source)] }
    rows[key] = CLIENTS.map do |client, source|
      cell = cells[source]
      next 'u' unless cell
      raw = cell.last
      raise "Invalid status in #{path}: #{raw}" unless raw.match?(/\A[ynau](?:\s+#\d+)*\s*\z/)
      source.first == 'gmail' && source.last != 'desktop-webmail' ? gmail_code(raw, notes, client.end_with?('non-google')) : raw[0]
    end.join

    # Audit trail stays out of the runtime bundle. Keep only current cells and
    # the notes they cite; don't carry obsolete restrictions into new results.
    refs = cells.values.compact.flat_map { |_, raw| raw.scan(/#(\d+)/).flatten }
    evidence[key] = { 'cells' => cells.values.map { |cell| cell&.join(' ') } }
    evidence[key]['notes'] = data['notes'] unless data['notes'].to_s.empty?
    cited = notes.select { |id, _| refs.include?(id) }
    evidence[key]['notes_by_num'] = cited unless cited.empty?
  end

  license = File.read('LICENSE', encoding: 'UTF-8')
  FileUtils.mkdir_p(OUTPUT)
  File.binwrite(File.join(OUTPUT, 'LICENSE'), license)
  File.open(File.join(OUTPUT, 'matrix.ts'), 'w:UTF-8') do |io|
    io.puts "/*! Can I email — https://github.com/hteumeuleu/caniemail/tree/#{REVISION}\n#{license}*/"
    io.puts '// Generated by scripts/refresh-email-support.rb. One upstream support code per client, in tuple order.'
    io.puts "export const clients = #{JSON.generate(CLIENTS.keys)} as const;"
    io.puts 'export const matrix: Readonly<Record<string, string>> = {'
    rows.each { |key, codes| io.puts "  #{key.to_json}: #{codes.to_json}," }
    io.puts '};'
  end
  File.open(File.join(OUTPUT, 'evidence.json'), 'w:UTF-8') do |io|
    io.puts '{', "  \"revision\": #{REVISION.to_json},"
    io.puts "  \"columns\": #{CLIENTS.values.compact.uniq.map { |source| source.join('/') }.to_json},"
    io.puts '  "features": {'
    io.puts evidence.map { |key, entry| "    #{key.to_json}: #{entry.to_json}" }.join(",\n")
    io.puts '  }', '}'
  end
  puts "Generated #{rows.size} features for #{CLIENTS.size} profiles from #{REVISION}"
end
