const { console, subtitle, sidebar } = iina;

export function register() {
  subtitle.registerProvider("ai-subtitle", {
    search: async () => {
      sidebar.show();
      return subtitle.CUSTOM_IMPLEMENTATION;
    },
    description: (item) => {
      return null;
    },
    download: async (item) => {
      return null;
    },
  });
  console.log("Sub provider registered");
}
