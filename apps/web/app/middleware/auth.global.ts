export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return;
  const { restore, session } = usePlatform();
  try {
    await restore();
  } catch {
    return navigateTo('/login');
  }
  if (to.path === '/users' && session.value?.user.role !== 'admin') return navigateTo('/');
});
