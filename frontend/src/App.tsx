import { AppProvider } from '@/context/AppContext';
import MainLayout from '@/pages/MainLayout';

export default function App() {
  return (
    <AppProvider>
      <MainLayout />
    </AppProvider>
  );
}
