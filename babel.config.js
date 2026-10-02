module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
    // Bundles drizzle-kit generated .sql migrations into the JS bundle.
    plugins: [['inline-import', { extensions: ['.sql'] }]],
  };
};
